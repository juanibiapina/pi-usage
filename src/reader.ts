import type { UsageCoordinator } from "./coordinator.js";
import { noCredentials } from "./errors.js";
import { createProvider, getProviderRefreshPolicy, hasCredentials } from "./registry.js";
import type { Dependencies, ProviderFetchResult, ProviderName, UsageResolution } from "./types.js";

export interface UsageReader {
	getUsage(provider: ProviderName): Promise<UsageResolution>;
}

export function createUsageReader(deps: Dependencies, coordinator: UsageCoordinator): UsageReader {
	async function fetchProvider(provider: ProviderName): Promise<ProviderFetchResult> {
		if (!hasCredentials(provider, deps)) {
			return { ok: false, error: noCredentials() };
		}
		return createProvider(provider).fetchUsage(deps);
	}

	return {
		getUsage(provider) {
			return coordinator.resolve(provider, getProviderRefreshPolicy(provider), () => fetchProvider(provider));
		},
	};
}
