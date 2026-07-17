import assert from "node:assert/strict";
import test from "node:test";
import createExtension from "../index.js";
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
				for (const handler of listeners.get(event) ?? []) {
					handler(payload);
				}
			},
		},
		on(event: string, handler: (event: any, ctx: any) => Promise<void>) {
			const handlers = lifecycleListeners.get(event) ?? [];
			handlers.push(handler);
			lifecycleListeners.set(event, handlers);
		},
	};

	async function fireLifecycle(event: string, ctx: any) {
		for (const handler of lifecycleListeners.get(event) ?? []) {
			await handler({}, ctx);
		}
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

function usageCoreUpdates(emitted: Array<{ event: string; payload: any }>) {
	return emitted.filter((e) => e.event === "usage-core:update-current" || e.event === "usage-core:ready");
}

test("emits no provider for non-matching model", async () => {
	const { pi, emitted, fireLifecycle } = createPi();
	createExtension(pi as any, createMockDeps());
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "bedrock", id: "claude-sonnet-4" } });

	const updates = usageCoreUpdates(emitted);
	assert.ok(updates.length > 0);
	const state = updates[updates.length - 1].payload.state as UsageCoreState;
	assert.equal(state.provider, undefined);
});

test("detects anthropic provider", async () => {
	const { pi, emitted, fireLifecycle } = createPi();
	createExtension(pi as any, createMockDeps());
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "anthropic", id: "claude-sonnet-4" } });

	const updates = usageCoreUpdates(emitted);
	assert.ok(updates.length > 0);
	const state = updates[updates.length - 1].payload.state as UsageCoreState;
	assert.equal(state.provider, "anthropic");
});

test("detects copilot provider", async () => {
	const { pi, emitted, fireLifecycle } = createPi();
	createExtension(pi as any, createMockDeps());
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "github", id: "copilot-model" } });

	const updates = usageCoreUpdates(emitted);
	const state = updates[updates.length - 1].payload.state as UsageCoreState;
	assert.equal(state.provider, "copilot");
});

test("detects xai provider", async () => {
	const { pi, emitted, fireLifecycle } = createPi();
	createExtension(pi as any, createMockDeps());
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "xai", id: "grok-4.5" } });

	const updates = usageCoreUpdates(emitted);
	const state = updates[updates.length - 1].payload.state as UsageCoreState;
	assert.equal(state.provider, "xai");
});

test("emits ready event on session_start", async () => {
	const { pi, emitted, fireLifecycle } = createPi();
	createExtension(pi as any, createMockDeps());
	emitted.length = 0;

	await fireLifecycle("session_start", { model: { provider: "anthropic", id: "claude-sonnet-4" } });

	const ready = emitted.filter((e) => e.event === "usage-core:ready");
	assert.equal(ready.length, 1);
});

test("turn_end does not force fetch (TTL fix)", async () => {
	const { pi, fireLifecycle } = createPi();
	let fetchCount = 0;
	const deps = createMockDeps({
		fetch: async () => {
			fetchCount++;
			return new Response(
				JSON.stringify({
					five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3600000).toISOString() },
					seven_day: { utilization: 20, resets_at: new Date(Date.now() + 86400000).toISOString() },
				}),
				{ status: 200 },
			);
		},
		fileExists: (p: string) => p.includes("auth.json"),
		readFile: (p: string) => {
			if (p.includes("auth.json")) return JSON.stringify({ anthropic: { access: "test-token" } });
			return undefined;
		},
	});

	createExtension(pi as any, deps);

	// session_start + model_select will trigger initial fetches.
	await fireLifecycle("session_start", { model: { provider: "anthropic", id: "claude-sonnet-4" } });
	await fireLifecycle("model_select", { model: { provider: "anthropic", id: "claude-sonnet-4" } });
	const fetchCountAfterInit = fetchCount;

	// turn_end should NOT fetch again (cache is fresh).
	await fireLifecycle("turn_end", { model: { provider: "anthropic", id: "claude-sonnet-4" } });

	assert.equal(fetchCount, fetchCountAfterInit, "turn_end should not trigger a new fetch when cache is fresh");
});
