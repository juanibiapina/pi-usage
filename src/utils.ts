/**
 * Shared utilities for providers.
 */

import type { Dependencies } from "./types.js";

export const API_TIMEOUT_MS = 5000;
export const CLI_TIMEOUT_MS = 10000;

export function formatReset(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";

	const diffMins = Math.floor(diffMs / 60000);
	if (diffMins < 60) return `${diffMins}m`;

	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

export function createTimeoutController(timeoutMs: number): { controller: AbortController; clear: () => void } {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
	return { controller, clear: () => clearTimeout(timeoutId) };
}

/**
 * Parse the Retry-After header from an HTTP response.
 * Supports both seconds ("60") and HTTP-date formats.
 * Returns milliseconds to wait, or undefined if not present/parseable.
 */
export function parseRetryAfter(res: Response): number | undefined {
	const header = res.headers.get("retry-after");
	if (!header) return undefined;

	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds > 0) {
		return seconds * 1000;
	}

	// Try HTTP-date format.
	const date = new Date(header);
	if (!Number.isNaN(date.getTime())) {
		const ms = date.getTime() - Date.now();
		return ms > 0 ? ms : undefined;
	}

	return undefined;
}

export function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
	return text.replace(/\x1B\[[0-9;?]*[A-Za-z]|\x1B\].*?\x07/g, "");
}

const SAFE_CLI_NAME = /^[a-zA-Z0-9._-]+$/;

export function whichSync(cmd: string, deps: Dependencies): string | null {
	if (!SAFE_CLI_NAME.test(cmd)) return null;
	try {
		return deps.execFileSync("which", [cmd], { encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}
