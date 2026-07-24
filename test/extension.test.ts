import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import createExtension from "../index.js";
import { createCache } from "../src/cache.js";
import type { Dependencies, UsageCoreState } from "../src/types.js";

function createPi() {
	const listeners = new Map<string, Array<(...args: any[]) => void>>();
	const lifecycleListeners = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
	const emitted: Array<{ event: string; payload: any }> = [];

	const pi = {
		events: {
			on(event: string, handler: (...args: any[]) => void) {
				const handlers = listeners.get(event) ?? [];
				handlers.push(handler);
				listeners.set(event, handlers);
			},
			emit(event: string, payload: any) {
				emitted.push({ event, payload });
				for (const handler of listeners.get(event) ?? []) handler(payload);
			},
		},
		on(event: string, handler: (event: any, ctx: any) => Promise<void>) {
			const handlers = lifecycleListeners.get(event) ?? [];
			handlers.push(handler);
			lifecycleListeners.set(event, handlers);
		},
	};

	async function fireLifecycle(event: string, ctx: any = {}) {
		for (const handler of lifecycleListeners.get(event) ?? []) await handler({}, ctx);
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

async function createTestExtension(t: test.TestContext, deps = createMockDeps(), initialNow = 0) {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-extension-"));
	let currentNow = initialNow;
	const cache = createCache({ dir, now: () => currentNow });
	const extension = createPi();
	createExtension(extension.pi as any, deps, cache);
	t.after(async () => {
		await extension.fireLifecycle("session_shutdown");
		await rm(dir, { recursive: true, force: true });
	});
	return {
		...extension,
		advance: (milliseconds: number) => {
			currentNow += milliseconds;
		},
		cache,
	};
}

function usageCoreUpdates(emitted: Array<{ event: string; payload: any }>) {
	return emitted.filter((e) => e.event === "usage-core:update-current" || e.event === "usage-core:ready");
}

function anthropicDeps(onFetch: () => void): Dependencies {
	return createMockDeps({
		fetch: async () => {
			onFetch();
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
					seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
				}),
				{ status: 200 },
			);
		},
		fileExists: (p: string) => p.includes("auth.json"),
		readFile: (p: string) =>
			p.includes("auth.json") ? JSON.stringify({ anthropic: { access: "test-token" } }) : undefined,
	});
}

test("emits no provider for non-matching model", async (t) => {
	const { emitted, fireLifecycle } = await createTestExtension(t);
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "bedrock", id: "claude-sonnet-4" } });

	const updates = usageCoreUpdates(emitted);
	assert.ok(updates.length > 0);
	const state = updates.at(-1)!.payload.state as UsageCoreState;
	assert.equal(state.provider, undefined);
});

test("detects anthropic provider", async (t) => {
	const { emitted, fireLifecycle } = await createTestExtension(t);
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "anthropic", id: "claude-sonnet-4" } });

	const updates = usageCoreUpdates(emitted);
	assert.ok(updates.length > 0);
	const state = updates.at(-1)!.payload.state as UsageCoreState;
	assert.equal(state.provider, "anthropic");
});

test("detects copilot provider", async (t) => {
	const { emitted, fireLifecycle } = await createTestExtension(t);
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "github", id: "copilot-model" } });

	const updates = usageCoreUpdates(emitted);
	const state = updates.at(-1)!.payload.state as UsageCoreState;
	assert.equal(state.provider, "copilot");
});

test("detects xai provider", async (t) => {
	const { emitted, fireLifecycle } = await createTestExtension(t);
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "xai", id: "grok-4.5" } });

	const updates = usageCoreUpdates(emitted);
	const state = updates.at(-1)!.payload.state as UsageCoreState;
	assert.equal(state.provider, "xai");
});

test("emits ready event on session_start", async (t) => {
	const { emitted, fireLifecycle } = await createTestExtension(t);
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "anthropic", id: "claude-sonnet-4" } });

	const ready = emitted.filter((e) => e.event === "usage-core:ready");
	assert.equal(ready.length, 1);
});

test("turn end does not fetch fresh usage", async (t) => {
	let fetchCount = 0;
	const { fireLifecycle } = await createTestExtension(
		t,
		anthropicDeps(() => fetchCount++),
	);
	const context = { model: { provider: "anthropic", id: "claude-sonnet-4" } };

	await fireLifecycle("session_start", context);
	await fireLifecycle("turn_end", context);

	assert.equal(fetchCount, 1);
});

test("turn end fetches usage older than the TTL", async (t) => {
	let fetchCount = 0;
	const { fireLifecycle, advance } = await createTestExtension(
		t,
		anthropicDeps(() => fetchCount++),
	);
	const context = { model: { provider: "anthropic", id: "claude-sonnet-4" } };

	await fireLifecycle("session_start", context);
	advance(60_000);
	await fireLifecycle("turn_end", context);

	assert.equal(fetchCount, 2);
});

test("turn end respects the active provider backoff", async (t) => {
	let fetchCount = 0;
	const { cache, fireLifecycle } = await createTestExtension(
		t,
		anthropicDeps(() => fetchCount++),
	);
	await cache.fetchWithCache("anthropic", 60_000, async () => ({
		usage: {
			provider: "anthropic",
			displayName: "Anthropic",
			windows: [],
			error: { code: "HTTP_ERROR", message: "rate limited" },
		},
	}));
	const context = { model: { provider: "anthropic", id: "claude-sonnet-4" } };

	await fireLifecycle("session_start", context);
	await fireLifecycle("turn_end", context);

	assert.equal(fetchCount, 0);
});
