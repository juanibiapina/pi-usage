/**
 * xAI / Grok SuperGrok usage provider.
 *
 * Uses the Grok CLI billing proxy with Pi OAuth credentials:
 *   GET https://cli-chat-proxy.grok.com/v1/billing              → monthly credits
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits → weekly pool
 */

import * as path from "path";
import { fetchFailed, httpError, noCredentials } from "../errors.js";
import { BaseProvider } from "../provider.js";
import type { Dependencies, FetchResult, RateWindow } from "../types.js";
import { API_TIMEOUT_MS, createTimeoutController, formatReset, parseRetryAfter } from "../utils.js";

const BILLING_BASE = "https://cli-chat-proxy.grok.com/v1/billing";

interface MonthlyConfig {
	monthlyLimit?: { val?: number };
	used?: { val?: number };
	billingPeriodEnd?: string;
}

interface WeeklyConfig {
	currentPeriod?: { type?: string; start?: string; end?: string };
	creditUsagePercent?: number;
	billingPeriodEnd?: string;
}

function loadXaiAccessToken(deps: Dependencies): string | undefined {
	// Pi OAuth store
	const piAuthPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (deps.fileExists(piAuthPath)) {
			const data = JSON.parse(deps.readFile(piAuthPath) ?? "{}");
			if (typeof data.xai?.access === "string" && data.xai.access.length > 0) {
				return data.xai.access;
			}
		}
	} catch {
		// Ignore parse errors
	}

	// Env fallbacks
	if (deps.env.XAI_OAUTH_TOKEN) return deps.env.XAI_OAUTH_TOKEN;
	if (deps.env.GROK_CLI_OAUTH_TOKEN) return deps.env.GROK_CLI_OAUTH_TOKEN;

	// Official Grok CLI auth file (~/.grok/auth.json or $GROK_HOME/auth.json)
	const grokHome = deps.env.GROK_HOME || path.join(deps.homedir(), ".grok");
	const grokAuthPath = path.join(grokHome, "auth.json");
	try {
		if (deps.fileExists(grokAuthPath)) {
			const data = JSON.parse(deps.readFile(grokAuthPath) ?? "{}");
			if (data && typeof data === "object") {
				for (const entry of Object.values(data as Record<string, unknown>)) {
					if (!entry || typeof entry !== "object") continue;
					const key = (entry as { key?: unknown }).key;
					if (typeof key === "string" && key.length > 0) return key;
				}
			}
		}
	} catch {
		// Ignore parse errors
	}

	return undefined;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

function parseMonthlyWindow(config: MonthlyConfig): RateWindow | undefined {
	const limit = config.monthlyLimit?.val;
	const used = config.used?.val;
	if (typeof limit !== "number" || limit <= 0 || typeof used !== "number" || used < 0) {
		return undefined;
	}

	const resetDate =
		typeof config.billingPeriodEnd === "string" && Number.isFinite(Date.parse(config.billingPeriodEnd))
			? new Date(config.billingPeriodEnd)
			: undefined;

	return {
		label: "Month",
		usedPercent: clampPercent((used / limit) * 100),
		resetDescription: resetDate ? formatReset(resetDate) : undefined,
		resetAt: resetDate?.toISOString(),
	};
}

function parseWeeklyWindow(config: WeeklyConfig): RateWindow | undefined {
	if (config.currentPeriod?.type !== "USAGE_PERIOD_TYPE_WEEKLY") {
		return undefined;
	}

	const end =
		(typeof config.billingPeriodEnd === "string" && config.billingPeriodEnd) ||
		(typeof config.currentPeriod.end === "string" && config.currentPeriod.end) ||
		undefined;
	const resetDate = end && Number.isFinite(Date.parse(end)) ? new Date(end) : undefined;

	// Endpoint may omit creditUsagePercent at the start of a fresh period.
	const raw = config.creditUsagePercent;
	const usedPercent = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;

	return {
		label: "Week",
		usedPercent: clampPercent(usedPercent),
		resetDescription: resetDate ? formatReset(resetDate) : undefined,
		resetAt: resetDate?.toISOString(),
	};
}

export class XaiProvider extends BaseProvider {
	readonly name = "xai" as const;
	readonly displayName = "Grok";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadXaiAccessToken(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<FetchResult> {
		const accessToken = loadXaiAccessToken(deps);
		if (!accessToken) {
			return this.result(this.emptySnapshot(noCredentials()));
		}

		const headers = {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			// Same client marker used by the Grok CLI / community tools.
			"x-xai-token-auth": "xai-grok-cli",
		};

		const windows: RateWindow[] = [];
		let retryAfterMs: number | undefined;

		// Monthly credits (optional companion window for powerbar sub-hourly).
		{
			const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
			try {
				const res = await deps.fetch(BILLING_BASE, {
					headers,
					signal: controller.signal,
				});
				clear();

				if (res.ok) {
					const data = (await res.json()) as { config?: MonthlyConfig };
					const monthly = data.config ? parseMonthlyWindow(data.config) : undefined;
					if (monthly) windows.push(monthly);
				} else if (res.status === 401 || res.status === 403) {
					return this.result(this.emptySnapshot(httpError(res.status)), parseRetryAfter(res));
				} else {
					retryAfterMs = parseRetryAfter(res) ?? retryAfterMs;
				}
			} catch {
				clear();
				// Fall through — weekly may still succeed.
			}
		}

		// Weekly SuperGrok pool (primary user-facing limit → powerbar sub-weekly when monthly present).
		{
			const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
			try {
				const res = await deps.fetch(`${BILLING_BASE}?format=credits`, {
					headers,
					signal: controller.signal,
				});
				clear();

				if (!res.ok) {
					// If we already have monthly data, return partial success.
					if (windows.length > 0) {
						return this.result(this.snapshot({ windows }), parseRetryAfter(res) ?? retryAfterMs);
					}
					return this.result(this.emptySnapshot(httpError(res.status)), parseRetryAfter(res));
				}

				const data = (await res.json()) as { config?: WeeklyConfig };
				const weekly = data.config ? parseWeeklyWindow(data.config) : undefined;
				if (weekly) windows.push(weekly);
			} catch {
				clear();
				if (windows.length === 0) {
					return this.result(this.emptySnapshot(fetchFailed()));
				}
			}
		}

		if (windows.length === 0) {
			return this.result(this.emptySnapshot(fetchFailed("No usage windows returned")));
		}

		return this.result(this.snapshot({ windows }), retryAfterMs);
	}
}
