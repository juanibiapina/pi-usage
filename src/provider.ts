/**
 * Provider interface and base class.
 */

import type { Dependencies, FetchResult, ProviderName, UsageError, UsageSnapshot } from "./types.js";

export interface UsageProvider {
	readonly name: ProviderName;
	readonly displayName: string;
	fetchUsage(deps: Dependencies): Promise<FetchResult>;
	hasCredentials?(deps: Dependencies): boolean;
}

export abstract class BaseProvider implements UsageProvider {
	abstract readonly name: ProviderName;
	abstract readonly displayName: string;
	abstract fetchUsage(deps: Dependencies): Promise<FetchResult>;

	hasCredentials(_deps: Dependencies): boolean {
		return true;
	}

	protected emptySnapshot(error?: UsageError): UsageSnapshot {
		return { provider: this.name, displayName: this.displayName, windows: [], error };
	}

	protected snapshot(data: Partial<Omit<UsageSnapshot, "provider" | "displayName">>): UsageSnapshot {
		return { provider: this.name, displayName: this.displayName, windows: [], ...data };
	}

	protected result(usage: UsageSnapshot, retryAfterMs?: number): FetchResult {
		return { usage, retryAfterMs };
	}
}
