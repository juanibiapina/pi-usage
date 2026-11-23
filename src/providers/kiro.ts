/**
 * AWS Kiro usage provider.
 *
 * Uses the Kiro management API with the Pi OAuth token (same token Pi sends for Kiro turns):
 *   POST https://management.<region>.kiro.dev/ListAvailableProfiles → profile ARN
 *   GET  https://management.<region>.kiro.dev/Get-Usage-Limits      → credit usage
 */

import * as path from "path";
import { fetchFailed, httpError, noCredentials, notLoggedIn } from "../errors.js";
import { BaseProvider } from "../provider.js";
import type { Dependencies, FetchResult, RateWindow } from "../types.js";
import { API_TIMEOUT_MS, createTimeoutController, formatReset, parseRetryAfter } from "../utils.js";

const FALLBACK_REGIONS = ["us-east-1", "eu-central-1"];

interface KiroAuth {
	access: string;
	region: string;
	profileArn?: string;
	expires?: number;
}

interface UsageBreakdown {
	resourceType?: string;
	currentUsage?: number;
	currentUsageWithPrecision?: number;
	usageLimit?: number;
	usageLimitWithPrecision?: number;
	nextDateReset?: number | string;
	overageCharges?: number;
	currency?: string;
}

interface UsageLimitsResponse {
	nextDateReset?: number | string;
	usageBreakdown?: UsageBreakdown;
	usageBreakdownList?: UsageBreakdown[];
}

function loadKiroAuth(deps: Dependencies): KiroAuth | undefined {
	const authPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (!deps.fileExists(authPath)) return undefined;
		const entry = JSON.parse(deps.readFile(authPath) ?? "{}").kiro;
		if (typeof entry?.access !== "string" || entry.access.length === 0) return undefined;
		return {
			access: entry.access,
			region: typeof entry.region === "string" && entry.region ? entry.region : "us-east-1",
			profileArn: typeof entry.profileArn === "string" ? entry.profileArn : undefined,
			expires: typeof entry.expires === "number" ? entry.expires : undefined,
		};
	} catch {
		return undefined;
	}
}

function managementUrl(region: string, endpoint: string): URL {
	return new URL(endpoint, `https://management.${region}.kiro.dev/`);
}

function authHeaders(token: string): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
	if (token.startsWith("ksk_")) headers.tokentype = "API_KEY";
	return headers;
}

async function timedFetch(deps: Dependencies, url: URL, init: RequestInit): Promise<Response> {
	const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
	try {
		return await deps.fetch(url, { ...init, signal: controller.signal });
	} finally {
		clear();
	}
}

/** The profile lives in one region; probe the login region first, then the canonical ones. */
async function resolveProfile(
	deps: Dependencies,
	auth: KiroAuth,
): Promise<{ region: string; arn: string } | { response: Response }> {
	if (auth.profileArn) return { region: auth.region, arn: auth.profileArn };
	const regions = [...new Set([auth.region, ...FALLBACK_REGIONS])];
	let lastFailure: Response | undefined;
	for (const region of regions) {
		try {
			const res = await timedFetch(deps, managementUrl(region, "ListAvailableProfiles"), {
				method: "POST",
				headers: { ...authHeaders(auth.access), "Content-Type": "application/json" },
				body: "{}",
			});
			if (!res.ok) {
				lastFailure = res;
				continue;
			}
			const data = (await res.json()) as { profiles?: Array<{ arn?: string }> };
			const arn = data.profiles?.find((profile) => profile.arn)?.arn;
			if (arn) return { region, arn };
		} catch {
			// Unreachable region says nothing about the token; try the next one.
		}
	}
	return { response: lastFailure ?? new Response(null, { status: 502 }) };
}

function toDate(value: number | string | undefined): Date | undefined {
	if (value === undefined || value === null) return undefined;
	const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function creditWindow(data: UsageLimitsResponse): RateWindow | undefined {
	const buckets = data.usageBreakdownList?.length
		? data.usageBreakdownList
		: data.usageBreakdown
			? [data.usageBreakdown]
			: [];
	const bucket = buckets.find((b) => b.resourceType === "CREDIT") ?? buckets[0];
	if (!bucket) return undefined;

	const used = bucket.currentUsageWithPrecision ?? bucket.currentUsage;
	const limit = bucket.usageLimitWithPrecision ?? bucket.usageLimit;
	if (typeof used !== "number" || typeof limit !== "number" || !Number.isFinite(used) || !(limit > 0))
		return undefined;

	const resetDate = toDate(bucket.nextDateReset ?? data.nextDateReset);
	return {
		label: "Credits",
		// Not capped at 100: overage credits are real consumption.
		usedPercent: Math.max(0, (used / limit) * 100),
		resetDescription: resetDate ? formatReset(resetDate) : undefined,
		resetAt: resetDate?.toISOString(),
		used,
		limit,
		overage:
			typeof bucket.overageCharges === "number" && bucket.overageCharges > 0
				? { charges: bucket.overageCharges, currency: bucket.currency || "USD" }
				: undefined,
	};
}

export class KiroProvider extends BaseProvider {
	readonly name = "kiro" as const;
	readonly displayName = "Kiro Plan";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadKiroAuth(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<FetchResult> {
		const auth = loadKiroAuth(deps);
		if (!auth) return this.result(this.emptySnapshot(noCredentials()));
		// Pi refreshes the token on Kiro turns; an expired one cannot be refreshed here.
		if (auth.expires !== undefined && auth.expires <= Date.now()) {
			return this.result(this.emptySnapshot(notLoggedIn()));
		}

		try {
			const profile = await resolveProfile(deps, auth);
			if ("response" in profile) {
				return this.result(
					this.emptySnapshot(httpError(profile.response.status)),
					parseRetryAfter(profile.response),
				);
			}

			const url = managementUrl(profile.region, "Get-Usage-Limits");
			url.searchParams.set("profileArn", profile.arn);
			url.searchParams.set("origin", "KIRO_CLI");
			url.searchParams.set("resourceType", "CREDIT");
			url.searchParams.set("isEmailRequired", "false");

			const res = await timedFetch(deps, url, { headers: authHeaders(auth.access) });
			if (!res.ok) return this.result(this.emptySnapshot(httpError(res.status)), parseRetryAfter(res));

			const window = creditWindow((await res.json()) as UsageLimitsResponse);
			if (!window) return this.result(this.emptySnapshot(fetchFailed("No credit usage returned")));
			return this.result(this.snapshot({ windows: [window] }));
		} catch {
			return this.result(this.emptySnapshot(fetchFailed()));
		}
	}

	// Kiro doesn't have a public status page
}
