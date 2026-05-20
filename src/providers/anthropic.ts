/**
 * Anthropic/Claude usage provider
 */

import * as path from "path";
import { fetchFailed, httpError, noCredentials } from "../errors.js";
import { BaseProvider } from "../provider.js";
import type { Dependencies, FetchResult, RateWindow } from "../types.js";
import { API_TIMEOUT_MS, createTimeoutController, formatReset, parseRetryAfter } from "../utils.js";

/**
 * Load Claude API token from various sources
 */
function loadClaudeToken(deps: Dependencies): string | undefined {
	// Try pi auth.json first
	const piAuthPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (deps.fileExists(piAuthPath)) {
			const data = JSON.parse(deps.readFile(piAuthPath) ?? "{}");
			if (data.anthropic?.access) return data.anthropic.access;
		}
	} catch {
		// Ignore parse errors
	}

	// Try macOS Keychain (Claude Code credentials)
	try {
		const keychainData = deps
			.execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			})
			.trim();
		if (keychainData) {
			const parsed = JSON.parse(keychainData);
			const scopes = parsed.claudeAiOauth?.scopes || [];
			if (scopes.includes("user:profile") && parsed.claudeAiOauth?.accessToken) {
				return parsed.claudeAiOauth.accessToken;
			}
		}
	} catch {
		// Keychain access failed
	}

	return undefined;
}

function formatExtraUsageCredits(credits: number): string {
	return (credits / 100).toFixed(2);
}

export class AnthropicProvider extends BaseProvider {
	readonly name = "anthropic" as const;
	readonly displayName = "Claude Plan";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadClaudeToken(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<FetchResult> {
		const token = loadClaudeToken(deps);
		if (!token) {
			return this.result(this.emptySnapshot(noCredentials()));
		}

		const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);

		try {
			const res = await deps.fetch("https://api.anthropic.com/api/oauth/usage", {
				headers: {
					Authorization: `Bearer ${token}`,
					"anthropic-beta": "oauth-2025-04-20",
				},
				signal: controller.signal,
			});
			clear();

			if (!res.ok) {
				return this.result(this.emptySnapshot(httpError(res.status)), parseRetryAfter(res));
			}

			const data = (await res.json()) as {
				five_hour?: { utilization?: number; resets_at?: string };
				seven_day?: { utilization?: number; resets_at?: string };
				extra_usage?: {
					is_enabled?: boolean;
					used_credits?: number;
					monthly_limit?: number;
					utilization?: number;
				};
			};

			const windows: RateWindow[] = [];

			if (data.five_hour?.utilization !== undefined) {
				const resetAt = data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : undefined;
				windows.push({
					label: "5h",
					usedPercent: data.five_hour.utilization,
					resetDescription: resetAt ? formatReset(resetAt) : undefined,
					resetAt: resetAt?.toISOString(),
				});
			}

			if (data.seven_day?.utilization !== undefined) {
				const resetAt = data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : undefined;
				windows.push({
					label: "Week",
					usedPercent: data.seven_day.utilization,
					resetDescription: resetAt ? formatReset(resetAt) : undefined,
					resetAt: resetAt?.toISOString(),
				});
			}

			// Extra usage
			const extraUsageEnabled = data.extra_usage?.is_enabled === true;
			const fiveHourUsage = data.five_hour?.utilization ?? 0;

			if (extraUsageEnabled) {
				const extra = data.extra_usage!;
				const usedCredits = extra.used_credits || 0;
				const monthlyLimit = extra.monthly_limit;
				const utilization = extra.utilization || 0;
				// "active" when 5h >= 99%, otherwise "on"
				const extraStatus = fiveHourUsage >= 99 ? "active" : "on";
				let label: string;
				if (monthlyLimit && monthlyLimit > 0) {
					label = `Extra [${extraStatus}] ${formatExtraUsageCredits(usedCredits)}/${formatExtraUsageCredits(monthlyLimit)}`;
				} else {
					label = `Extra [${extraStatus}] ${formatExtraUsageCredits(usedCredits)}`;
				}

				windows.push({
					label,
					usedPercent: utilization,
					resetDescription: extraStatus === "active" ? "__ACTIVE__" : undefined,
				});
			}

			return this.result(this.snapshot({ windows }));
		} catch {
			clear();
			return this.result(this.emptySnapshot(fetchFailed()));
		}
	}
}
