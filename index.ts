/**
 * pi-usage — coordinated subscription usage for supported providers.
 *
 * Emits:
 *   - "usage-core:ready"          → { state: UsageCoreState }
 *   - "usage-core:update-current" → { state: UsageCoreState }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUsageCoordinator, getUsageStateDir, type UsageCoordinator } from "./src/coordinator.js";
import { createDefaultDependencies } from "./src/dependencies.js";
import { detectProvider } from "./src/detection.js";
import { noCredentials } from "./src/errors.js";
import { createProvider, getProviderRefreshPolicy, hasCredentials } from "./src/registry.js";
import type { Dependencies, ProviderFetchResult, ProviderName, UsageCoreState, UsageResolution } from "./src/types.js";

type GlobalGuard = { active: boolean };
const global = globalThis as typeof globalThis & { __piUsage?: GlobalGuard };
const productionUsageCoordinator = createUsageCoordinator({ dir: getUsageStateDir() });

function stateFromResolution(provider: ProviderName, resolution: UsageResolution): UsageCoreState {
	if (resolution.availability === "available") {
		return {
			provider,
			usage: resolution.usage,
			availability: resolution.availability,
			freshness: resolution.freshness,
			source: resolution.source,
			fetchedAt: resolution.fetchedAt,
			observedAt: resolution.observedAt,
			staleReason: resolution.staleReason,
			retryAt: resolution.retryAt,
			error: resolution.error,
		};
	}
	return {
		provider,
		availability: resolution.availability,
		observedAt: resolution.observedAt,
		reason: resolution.reason,
		retryAt: resolution.retryAt,
		error: resolution.error,
	};
}

export default function createExtension(
	pi: ExtensionAPI,
	deps?: Dependencies,
	coordinator: UsageCoordinator = productionUsageCoordinator,
): void {
	const resolvedDeps = deps ?? createDefaultDependencies();
	if (!deps && global.__piUsage?.active) return;
	if (!deps) global.__piUsage = { active: true };

	let lastState: UsageCoreState = { observedAt: Date.now() };

	function emitState(state: UsageCoreState): void {
		lastState = state;
		pi.events.emit("usage-core:update-current", { state });
	}

	async function fetchProvider(provider: ProviderName): Promise<ProviderFetchResult> {
		if (!hasCredentials(provider, resolvedDeps)) {
			return { ok: false, error: noCredentials() };
		}
		return createProvider(provider).fetchUsage(resolvedDeps);
	}

	async function resolve(ctx: ExtensionContext): Promise<void> {
		const provider = detectProvider(ctx.model);
		if (!provider) {
			emitState({ observedAt: Date.now() });
			return;
		}

		const resolution = await coordinator.resolve(provider, getProviderRefreshPolicy(provider), () =>
			fetchProvider(provider),
		);
		emitState(stateFromResolution(provider, resolution));
	}

	pi.on("session_start", async (_event, ctx) => {
		await resolve(ctx);
		pi.events.emit("usage-core:ready", { state: lastState });
	});

	pi.on("model_select", async (_event, ctx) => {
		await resolve(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await resolve(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (!deps) global.__piUsage = undefined;
	});
}
