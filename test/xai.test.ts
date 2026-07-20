import assert from "node:assert/strict";
import test from "node:test";
import { XaiProvider } from "../src/providers/xai.js";
import type { Dependencies } from "../src/types.js";

function createDeps(overrides?: Partial<Dependencies> & { responses?: Record<string, unknown> }): Dependencies {
	const responses = overrides?.responses ?? {};
	return {
		fetch: async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = responses[url] ?? responses["*"];
			if (!body) return new Response("not found", { status: 404 });
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
		readFile: (p) => {
			if (String(p).endsWith("auth.json")) {
				return JSON.stringify({ xai: { type: "oauth", access: "test-token" } });
			}
			return undefined;
		},
		fileExists: (p) => String(p).endsWith("auth.json"),
		execFileSync: () => "",
		homedir: () => "/tmp/test-home",
		env: {},
		...overrides,
	};
}

test("xai hasCredentials reads pi auth.json", () => {
	const provider = new XaiProvider();
	assert.equal(provider.hasCredentials(createDeps()), true);
});

test("xai hasCredentials false without token", () => {
	const provider = new XaiProvider();
	assert.equal(
		provider.hasCredentials(
			createDeps({
				fileExists: () => false,
				readFile: () => undefined,
				env: {},
			}),
		),
		false,
	);
});

test("xai fetchUsage maps monthly + weekly windows", async () => {
	const provider = new XaiProvider();
	const monthlyUrl = "https://cli-chat-proxy.grok.com/v1/billing";
	const weeklyUrl = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

	const result = await provider.fetchUsage(
		createDeps({
			responses: {
				[monthlyUrl]: {
					config: {
						monthlyLimit: { val: 100000 },
						used: { val: 25000 },
						billingPeriodEnd: "2026-08-01T00:00:00+00:00",
					},
				},
				[weeklyUrl]: {
					config: {
						currentPeriod: {
							type: "USAGE_PERIOD_TYPE_WEEKLY",
							start: "2026-07-17T00:00:00+00:00",
							end: "2026-07-24T00:00:00+00:00",
						},
						creditUsagePercent: 11,
						billingPeriodEnd: "2026-07-24T00:00:00+00:00",
					},
				},
			},
		}),
	);

	assert.equal(result.usage.provider, "xai");
	assert.equal(result.usage.displayName, "Grok");
	assert.equal(result.usage.windows.length, 2);
	assert.equal(result.usage.windows[0]?.label, "Month");
	assert.equal(result.usage.windows[0]?.usedPercent, 25);
	assert.equal(result.usage.windows[1]?.label, "Week");
	assert.equal(result.usage.windows[1]?.usedPercent, 11);
	assert.equal(result.usage.windows[1]?.resetAt, "2026-07-24T00:00:00.000Z");
});

test("xai fetchUsage defaults missing weekly percent to 0", async () => {
	const provider = new XaiProvider();
	const weeklyUrl = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

	const result = await provider.fetchUsage(
		createDeps({
			responses: {
				"https://cli-chat-proxy.grok.com/v1/billing": { config: {} },
				[weeklyUrl]: {
					config: {
						currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-24T00:00:00+00:00" },
						billingPeriodEnd: "2026-07-24T00:00:00+00:00",
					},
				},
			},
		}),
	);

	assert.equal(result.usage.windows.length, 1);
	assert.equal(result.usage.windows[0]?.label, "Week");
	assert.equal(result.usage.windows[0]?.usedPercent, 0);
});
