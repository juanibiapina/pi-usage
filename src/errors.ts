/**
 * Error constructors for usage fetch failures.
 */

import type { UsageError, UsageErrorCode } from "./types.js";

export function noCredentials(): UsageError {
	return { code: "NO_CREDENTIALS", message: "No credentials found" };
}

export function noCli(name: string): UsageError {
	return { code: "NO_CLI", message: `${name} CLI not found` };
}

export function notLoggedIn(): UsageError {
	return { code: "NOT_LOGGED_IN", message: "Not logged in" };
}

export function fetchFailed(reason?: string): UsageError {
	return { code: "FETCH_FAILED", message: reason ?? "Fetch failed" };
}

export function httpError(status: number): UsageError {
	return { code: "HTTP_ERROR", message: `HTTP ${status}`, httpStatus: status };
}

export function apiError(message: string): UsageError {
	return { code: "API_ERROR", message };
}

/**
 * Expected missing data errors — provider not configured, not an actual failure.
 */
const EXPECTED_CODES = new Set<UsageErrorCode>(["NO_CREDENTIALS", "NO_CLI", "NOT_LOGGED_IN"]);

export function isExpectedMissingData(error: UsageError): boolean {
	return EXPECTED_CODES.has(error.code);
}
