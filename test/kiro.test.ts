import assert from "node:assert/strict";
import test from "node:test";
import { KiroProvider } from "../src/providers/kiro.js";
import type { Dependencies } from "../src/types.js";

const ARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/TEST";

let tokenCount = 0;
const freshToken = () => `tok-${++tokenCount}`;

function createDeps(options?: { auth?: unknown; usage?: unknown; usageStatus?: number }): {
	deps: Dependencies;
	urls: string[];
} {
	const urls: string[] = [];
	const auth =
		options && "auth" in options ? options.auth : { kiro: { access: freshToken(), region: "eu-central-1" } };
	const deps: Dependencies = {
		fetch: async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("ListAvailableProfiles")) return Response.json({ profiles: [{ arn: ARN }] });
			if (url.includes("Get-Usage-Limits")) {
				return Response.json(options?.usage ?? {}, { status: options?.usageStatus ?? 200 });
			}
			return new Response("not found", { status: 404 });
		},
		readFile: () => (auth === undefined ? undefined : JSON.stringify(auth)),
		fileExists: () => auth !== undefined,
		execFileSync: () => {
			throw new Error("kiro-cli must not be called");
		},
		homedir: () => "/tmp/test-home",
		env: {},
	};
	return { deps, urls };
}

const usage = {
	usageBreakdownList: [
		{
			resourceType: "CREDIT",
			currentUsageWithPrecision: 7748.34,
			usageLimitWithPrecision: 5000,
			nextDateReset: 1796083200,
			overageCharges: 109.93,
			currency: "USD",
		},
	],
};

test("kiro reports credit usage from the management API, uncapped", async () => {
	const { deps, urls } = createDeps({ usage });
	const result = await new KiroProvider().fetchUsage(deps);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	const [window] = result.usage.windows;
	assert.equal(window.label, "Credits");
	assert.ok(Math.abs(window.usedPercent - 154.9668) < 0.001);
	assert.equal(window.resetAt, "2026-12-01T00:00:00.000Z");
	assert.equal(window.used, 7748.34);
	assert.equal(window.limit, 5000);
	assert.deepEqual(window.overage, { charges: 109.93, currency: "USD" });
	assert.ok(urls[0].startsWith("https://management.eu-central-1.kiro.dev/ListAvailableProfiles"));
	assert.ok(urls[1].includes(`profileArn=${encodeURIComponent(ARN)}`));
});

test("kiro hasCredentials reads pi auth.json", () => {
	assert.equal(new KiroProvider().hasCredentials(createDeps().deps), true);
	assert.equal(new KiroProvider().hasCredentials(createDeps({ auth: {} }).deps), false);
});

test("kiro without credentials is NO_CREDENTIALS", async () => {
	const result = await new KiroProvider().fetchUsage(createDeps({ auth: {} }).deps);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, "NO_CREDENTIALS");
});

test("kiro unparseable usage is an error, not 0%", async () => {
	const result = await new KiroProvider().fetchUsage(createDeps({ usage: {} }).deps);
	assert.equal(result.ok, false);
});

test("kiro without a CREDIT bucket is an error", async () => {
	const other = { usageBreakdownList: [{ resourceType: "AGENTIC_REQUEST", currentUsage: 10, usageLimit: 50 }] };
	const result = await new KiroProvider().fetchUsage(createDeps({ usage: other }).deps);
	assert.equal(result.ok, false);
});

test("kiro lists profiles once per token", async () => {
	const { deps, urls } = createDeps({ usage });
	await new KiroProvider().fetchUsage(deps);
	const result = await new KiroProvider().fetchUsage(deps);
	assert.equal(result.ok, true);
	assert.equal(urls.filter((url) => url.includes("ListAvailableProfiles")).length, 1);
});

test("kiro surfaces HTTP errors", async () => {
	const result = await new KiroProvider().fetchUsage(createDeps({ usageStatus: 403 }).deps);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.httpStatus, 403);
});

test("kiro probes fallback regions when the login region has no profile", async () => {
	const urls: string[] = [];
	const { deps } = createDeps({ usage });
	deps.fetch = async (input: RequestInfo | URL) => {
		const url = String(input);
		urls.push(url);
		if (url.includes("management.eu-west-2.") && url.includes("ListAvailableProfiles")) {
			return new Response("forbidden", { status: 403 });
		}
		if (url.includes("management.us-east-1.") && url.includes("ListAvailableProfiles")) {
			return Response.json({ profiles: [{ arn: ARN }] });
		}
		if (url.includes("management.us-east-1.") && url.includes("Get-Usage-Limits")) return Response.json(usage);
		return new Response("not found", { status: 404 });
	};
	deps.readFile = () => JSON.stringify({ kiro: { access: freshToken(), region: "eu-west-2" } });
	const result = await new KiroProvider().fetchUsage(deps);
	assert.equal(result.ok, true);
	assert.ok(urls.at(-1)?.startsWith("https://management.us-east-1.kiro.dev/Get-Usage-Limits"));
});

test("kiro uses a stored profileArn without listing profiles", async () => {
	const { deps, urls } = createDeps({
		usage,
		auth: { kiro: { access: freshToken(), region: "eu-central-1", profileArn: ARN } },
	});
	const result = await new KiroProvider().fetchUsage(deps);
	assert.equal(result.ok, true);
	assert.equal(urls.length, 1);
	assert.ok(urls[0].includes("Get-Usage-Limits"));
});

test("kiro queries the stored profileArn's region, not the login region", async () => {
	const { deps, urls } = createDeps({
		usage,
		auth: { kiro: { access: freshToken(), region: "eu-west-1", profileArn: ARN } },
	});
	const result = await new KiroProvider().fetchUsage(deps);
	assert.equal(result.ok, true);
	assert.ok(urls[0].startsWith("https://management.eu-central-1.kiro.dev/Get-Usage-Limits"));
});

test("kiro sends tokentype EXTERNAL_IDP only for external IdP tokens", async () => {
	const jwt = (aud: string) => ["e30", Buffer.from(JSON.stringify({ aud })).toString("base64url"), "sig"].join(".");
	const tokenTypes = async (access: string) => {
		const seen: Array<string | undefined> = [];
		const { deps } = createDeps({ usage, auth: { kiro: { access, region: "eu-central-1" } } });
		const fetch = deps.fetch;
		deps.fetch = async (input, init) => {
			seen.push(new Headers(init?.headers).get("tokentype") ?? undefined);
			return fetch(input, init);
		};
		await new KiroProvider().fetchUsage(deps);
		return seen;
	};
	assert.deepEqual(await tokenTypes(jwt("api://kiro")), ["EXTERNAL_IDP", "EXTERNAL_IDP"]);
	assert.deepEqual(await tokenTypes(jwt("other")), [undefined, undefined]);
	assert.deepEqual(await tokenTypes("opaque-sso-token"), [undefined, undefined]);
});

test("kiro without any profile is a fetch failure, not an HTTP error", async () => {
	const { deps } = createDeps();
	deps.fetch = async () => Response.json({ profiles: [] });
	const result = await new KiroProvider().fetchUsage(deps);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.error.code, "FETCH_FAILED");
		assert.equal(result.error.httpStatus, undefined);
	}
});

test("kiro omits overage when none is charged", async () => {
	const within = {
		usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 10, usageLimit: 5000, overageCharges: 0 }],
	};
	const result = await new KiroProvider().fetchUsage(createDeps({ usage: within }).deps);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.usage.windows[0].overage, undefined);
});
