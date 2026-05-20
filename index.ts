/**
 * pi-usage — Subscription usage extension for all providers.
 *
 * Simplified fork of @marckrenn/pi-sub-core (https://github.com/marckrenn/pi-sub).
 * Supports all providers (anthropic, copilot, gemini, antigravity, codex, kiro, zai)
 * with two bug fixes:
 *
 * 1. Bedrock false positive: detection no longer falls back to model tokens when
 *    the provider field is explicitly set and doesn't match any known provider.
 *
 * 2. Aggressive refresh on turn_end/tool_result: always respects cache TTL instead
 *    of bypassing it with force:true (see https://github.com/marckrenn/pi-sub/issues/58).
 *
 * Emits:
 *   - "usage-core:ready"          → { state: UsageCoreState }
 *   - "usage-core:update-current" → { state: UsageCoreState }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchWithCache, getGoodUsage, watchCache } from "./src/cache.js";
import { createDefaultDependencies } from "./src/dependencies.js";
import { detectProvider } from "./src/detection.js";
import { createProvider, hasCredentials } from "./src/registry.js";
import type { Dependencies, ProviderName, UsageCoreState, UsageSnapshot } from "./src/types.js";

const REFRESH_INTERVAL_MS = 60_000;

type GlobalGuard = { active: boolean };
const global = globalThis as typeof globalThis & { __piUsage?: GlobalGuard };

export default function createExtension(pi: ExtensionAPI, deps?: Dependencies): void {
	const resolvedDeps = deps ?? createDefaultDependencies();
	// Prevent double-init when bundled alongside other extensions.
	// Skip the guard when deps are explicitly provided (test mode).
	if (!deps && global.__piUsage?.active) return;
	if (!deps) global.__piUsage = { active: true };

	let lastContext: ExtensionContext | undefined;
	let lastState: UsageCoreState = {};
	let lastSnapshot = "";
	let currentProvider: ProviderName | undefined;
	let stopCacheWatch: (() => void) | undefined;

	// --- Emit helpers ---

	function emitState(state: UsageCoreState): void {
		const json = JSON.stringify(state);
		if (json === lastSnapshot) return;
		lastSnapshot = json;
		lastState = state;
		pi.events.emit("usage-core:update-current", { state });
	}

	function setupCacheWatch(provider: ProviderName): void {
		stopCacheWatch?.();
		stopCacheWatch = watchCache(provider, (usage: UsageSnapshot) => {
			if (currentProvider === provider) {
				emitState({ provider, usage });
			}
		});
	}

	// --- Refresh ---

	async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
		lastContext = ctx;

		const detected = detectProvider(ctx.model);
		if (!detected) {
			currentProvider = undefined;
			emitState({});
			return;
		}

		// Provider changed — reset.
		if (detected !== currentProvider) {
			currentProvider = detected;
			setupCacheWatch(detected);
		}

		if (!hasCredentials(detected, resolvedDeps)) {
			emitState({ provider: detected });
			return;
		}

		// Check cache first (unless forced).
		if (!force) {
			const cached = getGoodUsage(detected, REFRESH_INTERVAL_MS);
			if (cached) {
				emitState({ provider: detected, usage: cached });
				return;
			}
		}

		const providerInstance = createProvider(detected);
		const usage = await fetchWithCache(detected, REFRESH_INTERVAL_MS, () =>
			providerInstance.fetchUsage(resolvedDeps),
		);

		// Only emit when we got good data. On errors (429 etc.),
		// fetchWithCache writes a backoff file so all instances wait.
		// UI keeps showing last good state.
		if (usage) {
			emitState({ provider: detected, usage });
		}
	}

	// --- Periodic refresh ---

	const refreshTimer = setInterval(() => {
		if (!lastContext || !currentProvider) return;
		void refresh(lastContext);
	}, REFRESH_INTERVAL_MS);
	refreshTimer.unref?.();

	// --- Lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		await refresh(ctx);
		pi.events.emit("usage-core:ready", { state: lastState });
	});

	pi.on("model_select" as any, async (_event: unknown, ctx: ExtensionContext) => {
		// Model changed — force refresh.
		await refresh(ctx, true);
	});

	pi.on("turn_start", async (_event, ctx) => {
		// Respect TTL — emit cached, don't force.
		lastContext = ctx;
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Respect TTL — this is the fix for pi-sub#58.
		lastContext = ctx;
	});

	pi.on("session_switch" as any, async (_event: unknown, ctx: ExtensionContext) => {
		currentProvider = undefined;
		await refresh(ctx, true);
	});

	pi.on("session_shutdown", async () => {
		clearInterval(refreshTimer);
		stopCacheWatch?.();
		lastContext = undefined;
		if (!deps) global.__piUsage = undefined;
	});
}
