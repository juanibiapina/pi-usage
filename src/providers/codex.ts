/**
 * OpenAI Codex usage provider
 */

import * as path from "path";
import { fetchFailed, httpError, noCredentials } from "../errors.js";
import { BaseProvider } from "../provider.js";
import type { Dependencies, FetchResult, RateWindow } from "../types.js";
import { API_TIMEOUT_MS, createTimeoutController, formatReset, parseRetryAfter } from "../utils.js";

/**
 * Load Codex credentials from auth.json
 * First tries pi's auth.json, then falls back to legacy codex location
 */
function loadCodexCredentials(deps: Dependencies): { accessToken?: string; accountId?: string } {
	// Try pi's auth.json first
	const piAuthPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (deps.fileExists(piAuthPath)) {
			const data = JSON.parse(deps.readFile(piAuthPath) ?? "{}");
			if (data["openai-codex"]?.access) {
				return {
					accessToken: data["openai-codex"].access,
					accountId: data["openai-codex"].accountId,
				};
			}
		}
	} catch {
		// Ignore parse errors, try legacy location
	}

	// Fall back to legacy codex location
	const codexHome = deps.env.CODEX_HOME || path.join(deps.homedir(), ".codex");
	const authPath = path.join(codexHome, "auth.json");
	try {
		if (deps.fileExists(authPath)) {
			const data = JSON.parse(deps.readFile(authPath) ?? "{}");
			if (data.OPENAI_API_KEY) {
				return { accessToken: data.OPENAI_API_KEY };
			} else if (data.tokens?.access_token) {
				return {
					accessToken: data.tokens.access_token,
					accountId: data.tokens.account_id,
				};
			}
		}
	} catch {
		// Ignore parse errors
	}

	return {};
}

export class CodexProvider extends BaseProvider {
	readonly name = "codex" as const;
	readonly displayName = "Codex Plan";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadCodexCredentials(deps).accessToken);
	}

	async fetchUsage(deps: Dependencies): Promise<FetchResult> {
		const { accessToken, accountId } = loadCodexCredentials(deps);
		if (!accessToken) {
			return this.result(this.emptySnapshot(noCredentials()));
		}

		const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);

		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			};
			if (accountId) {
				headers["ChatGPT-Account-Id"] = accountId;
			}

			const res = await deps.fetch("https://chatgpt.com/backend-api/wham/usage", {
				headers,
				signal: controller.signal,
			});
			clear();

			if (!res.ok) {
				return this.result(this.emptySnapshot(httpError(res.status)), parseRetryAfter(res));
			}

			const data = (await res.json()) as {
				rate_limit?: {
					primary_window?: {
						reset_at?: number;
						limit_window_seconds?: number;
						used_percent?: number;
					};
					secondary_window?: {
						reset_at?: number;
						limit_window_seconds?: number;
						used_percent?: number;
					};
				};
			};

			const windows: RateWindow[] = [];

			if (data.rate_limit?.primary_window) {
				const pw = data.rate_limit.primary_window;
				const resetDate = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined;
				const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
				windows.push({
					label: `${windowHours}h`,
					usedPercent: pw.used_percent || 0,
					resetDescription: resetDate ? formatReset(resetDate) : undefined,
					resetAt: resetDate?.toISOString(),
				});
			}

			if (data.rate_limit?.secondary_window) {
				const sw = data.rate_limit.secondary_window;
				const resetDate = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined;
				const windowHours = Math.round((sw.limit_window_seconds || 86400) / 3600);
				const label = windowHours >= 144 ? "Week" : windowHours >= 24 ? "Day" : `${windowHours}h`;
				windows.push({
					label,
					usedPercent: sw.used_percent || 0,
					resetDescription: resetDate ? formatReset(resetDate) : undefined,
					resetAt: resetDate?.toISOString(),
				});
			}

			return this.result(this.snapshot({ windows }));
		} catch {
			clear();
			return this.result(this.emptySnapshot(fetchFailed()));
		}
	}
}
