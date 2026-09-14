/**
 * Types for pi-usage.
 *
 * Derived from @marckrenn/pi-sub-shared, self-contained.
 */

import type { ExecFileSyncOptionsWithStringEncoding } from "child_process";

export const PROVIDERS = ["anthropic", "copilot", "gemini", "antigravity", "codex", "kiro", "zai", "xai"] as const;

export type ProviderName = (typeof PROVIDERS)[number];

export type UsageErrorCode =
	| "NO_CREDENTIALS"
	| "NO_CLI"
	| "NOT_LOGGED_IN"
	| "FETCH_FAILED"
	| "HTTP_ERROR"
	| "API_ERROR"
	| "TIMEOUT"
	| "UNKNOWN";

export interface UsageError {
	code: UsageErrorCode;
	message: string;
	httpStatus?: number;
}

export interface RateWindow {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetAt?: string;
}

export interface UsageSnapshot {
	provider: ProviderName;
	displayName: string;
	windows: RateWindow[];
	error?: UsageError;
	requestsRemaining?: number;
	requestsEntitlement?: number;
}

export interface ProviderRefreshPolicy {
	freshForMs: number;
	defaultBackoffMs: number;
	maxFetchMs: number;
}

export type ProviderFetchResult =
	| { ok: true; usage: UsageSnapshot }
	| { ok: false; error: UsageError; retryAfterMs?: number };

export type FetchResult = ProviderFetchResult;

export type UsageResolution =
	| {
			availability: "available";
			freshness: "fresh" | "stale";
			source: "cache" | "endpoint";
			usage: UsageSnapshot;
			fetchedAt: number;
			observedAt: number;
			staleReason?: "no-credentials" | "backoff" | "fetch-failed" | "lease-timeout";
			retryAt?: number;
			error?: UsageError;
	  }
	| {
			availability: "unavailable";
			observedAt: number;
			reason: "no-cache" | "no-credentials" | "backoff" | "fetch-failed" | "lease-timeout";
			retryAt?: number;
			error?: UsageError;
	  };

/**
 * State emitted by usage-core events.
 */
export interface UsageCoreState {
	provider?: ProviderName;
	usage?: UsageSnapshot;
	availability?: "available" | "unavailable";
	freshness?: "fresh" | "stale";
	source?: "cache" | "endpoint";
	fetchedAt?: number;
	observedAt?: number;
	staleReason?: "no-credentials" | "backoff" | "fetch-failed" | "lease-timeout";
	reason?: "no-cache" | "no-credentials" | "backoff" | "fetch-failed" | "lease-timeout";
	retryAt?: number;
	error?: UsageError;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface Dependencies {
	fetch: typeof globalThis.fetch;
	readFile: (path: string) => string | undefined;
	fileExists: (path: string) => boolean;
	execFileSync: (file: string, args: string[], options?: ExecFileSyncOptionsWithStringEncoding) => string;
	homedir: () => string;
	env: NodeJS.ProcessEnv;
}
