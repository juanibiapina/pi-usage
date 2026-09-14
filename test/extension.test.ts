import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import createExtension from "../index.js";
import { createUsageCoordinator } from "../src/coordinator.js";
import type { Dependencies, UsageCoreState } from "../src/types.js";

function createPi() {
	const lifecycleListeners = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
	const emitted: Array<{ event: string; payload: any }> = [];
	const pi = {
		events: {
			on() {
				return () => {};
			},
			emit(event: string, payload: any) {
				emitted.push({ event, payload });
			},
		},
		on(event: string, handler: (event: any, ctx: any) => Promise<void>) {
			const handlers = lifecycleListeners.get(event) ?? [];
			handlers.push(handler);
			lifecycleListeners.set(event, handlers);
		},
	};

	async function fireLifecycle(event: string, ctx: any = {}, eventData: any = {}) {
		for (const handler of lifecycleListeners.get(event) ?? []) await handler(eventData, ctx);
	}

	return { pi, emitted, fireLifecycle };
}

function createMockDeps(overrides?: Partial<Dependencies>): Dependencies {
	return {
		fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
		readFile: () => undefined,
		fileExists: () => false,
		execFileSync: () => "",
		homedir: () => "/tmp/test-home",
		env: {},
		...overrides,
	};
}

function anthropicDeps(onFetch: () => void, responseStatus = 200): Dependencies {
	return createMockDeps({
		fetch: async () => {
			onFetch();
			if (responseStatus !== 200) {
				return new Response("rate limited", { status: responseStatus, headers: { "retry-after": "120" } });
			}
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
					seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
				}),
				{ status: 200 },
			);
		},
		fileExists: (file) => file.includes("auth.json"),
		readFile: (file) =>
			file.includes("auth.json") ? JSON.stringify({ anthropic: { access: "test-token" } }) : undefined,
	});
}

async function createTestExtension(t: test.TestContext, deps: Dependencies, initialNow = 1_000) {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-extension-"));
	let now = initialNow;
	const extension = createPi();
	createExtension(extension.pi as any, deps, createUsageCoordinator({ dir, now: () => now }));
	t.after(async () => {
		await extension.fireLifecycle("session_shutdown");
		await rm(dir, { recursive: true, force: true });
	});
	return {
		...extension,
		advance(milliseconds: number) {
			now += milliseconds;
		},
	};
}

function updates(emitted: Array<{ event: string; payload: any }>): UsageCoreState[] {
	return emitted.filter((entry) => entry.event === "usage-core:update-current").map((entry) => entry.payload.state);
}

const anthropicContext = { model: { provider: "anthropic", id: "claude-sonnet-4" } };

test("session start resolves and announces current usage", async (t) => {
	let fetchCount = 0;
	const { emitted, fireLifecycle } = await createTestExtension(
		t,
		anthropicDeps(() => fetchCount++),
	);

	await fireLifecycle("session_start", anthropicContext);

	assert.equal(fetchCount, 1);
	assert.equal(updates(emitted).at(-1)?.availability, "available");
	assert.equal(updates(emitted).at(-1)?.freshness, "fresh");
	assert.equal(updates(emitted).at(-1)?.source, "endpoint");
	assert.equal(emitted.filter((entry) => entry.event === "usage-core:ready").length, 1);
});

test("resumed sessions resolve their selected provider during session_start", async (t) => {
	let fetchCount = 0;
	const { emitted, fireLifecycle } = await createTestExtension(
		t,
		anthropicDeps(() => fetchCount++),
	);

	await fireLifecycle("session_start", anthropicContext, { type: "session_start", reason: "resume" });

	assert.equal(fetchCount, 1);
	assert.equal(updates(emitted).at(-1)?.provider, "anthropic");
	assert.equal(updates(emitted).at(-1)?.availability, "available");
});

test("turn end resolves again but fresh state prevents another endpoint call", async (t) => {
	let fetchCount = 0;
	const { emitted, fireLifecycle, advance } = await createTestExtension(
		t,
		anthropicDeps(() => fetchCount++),
	);
	await fireLifecycle("session_start", anthropicContext);
	emitted.length = 0;
	advance(30_000);

	await fireLifecycle("turn_end", anthropicContext);

	assert.equal(fetchCount, 1);
	assert.equal(updates(emitted).length, 1);
	assert.equal(updates(emitted)[0]?.source, "cache");
	assert.equal(updates(emitted)[0]?.freshness, "fresh");
});

test("the first turn after freshness expiry returns new endpoint data", async (t) => {
	let fetchCount = 0;
	const { emitted, fireLifecycle, advance } = await createTestExtension(
		t,
		anthropicDeps(() => fetchCount++),
	);
	await fireLifecycle("session_start", anthropicContext);
	emitted.length = 0;
	advance(60_000);

	await fireLifecycle("turn_end", anthropicContext);

	assert.equal(fetchCount, 2);
	assert.equal(updates(emitted)[0]?.source, "endpoint");
	assert.equal(updates(emitted)[0]?.freshness, "fresh");
});

test("Retry-After blocks later turn-end endpoint calls", async (t) => {
	let fetchCount = 0;
	const { emitted, fireLifecycle, advance } = await createTestExtension(
		t,
		anthropicDeps(() => fetchCount++, 429),
	);
	await fireLifecycle("session_start", anthropicContext);
	emitted.length = 0;
	advance(30_000);

	await fireLifecycle("turn_end", anthropicContext);

	assert.equal(fetchCount, 1);
	assert.equal(updates(emitted)[0]?.availability, "unavailable");
	assert.equal(updates(emitted)[0]?.reason, "backoff");
});

test("unsupported models emit no provider", async (t) => {
	const { emitted, fireLifecycle } = await createTestExtension(t, createMockDeps());

	await fireLifecycle("session_start", { model: { provider: "bedrock", id: "claude-sonnet-4" } });

	assert.equal(updates(emitted).at(-1)?.provider, undefined);
});

test("the extension creates no recurring refresh timer", () => {
	const extension = createPi();
	const originalSetInterval = globalThis.setInterval;
	let intervalCount = 0;
	globalThis.setInterval = ((..._args: Parameters<typeof setInterval>) => {
		intervalCount += 1;
		return { unref() {} } as NodeJS.Timeout;
	}) as typeof setInterval;

	try {
		createExtension(extension.pi as any, createMockDeps(), {
			resolve: async () => ({ availability: "unavailable", observedAt: 0, reason: "no-cache" }),
		});
	} finally {
		globalThis.setInterval = originalSetInterval;
	}

	assert.equal(intervalCount, 0);
});
