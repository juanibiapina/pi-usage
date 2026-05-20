/**
 * Types for pi-usage.
 *
 * Derived from @marckrenn/pi-sub-shared, self-contained.
 */

import type { ExecFileSyncOptionsWithStringEncoding } from "child_process";

export const PROVIDERS = ["anthropic", "copilot", "gemini", "antigravity", "codex", "kiro", "zai"] as const;

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

/**
 * Result from a provider fetch. Includes the snapshot and optional retry
 * backoff parsed from the Retry-After header on error responses.
 */
export interface FetchResult {
	usage: UsageSnapshot;
	retryAfterMs?: number;
}

/**
 * State emitted by usage-core events.
 */
export interface UsageCoreState {
	provider?: ProviderName;
	usage?: UsageSnapshot;
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
