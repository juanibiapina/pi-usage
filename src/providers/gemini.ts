/**
 * Google Gemini usage provider
 */

import * as path from "path";
import { fetchFailed, httpError, noCredentials } from "../errors.js";
import { BaseProvider } from "../provider.js";
import type { Dependencies, FetchResult, RateWindow } from "../types.js";
import { API_TIMEOUT_MS, createTimeoutController, parseRetryAfter } from "../utils.js";

/**
 * Load Gemini access token from various sources
 */
function loadGeminiToken(deps: Dependencies): string | undefined {
	// Try pi auth.json first
	const piAuthPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (deps.fileExists(piAuthPath)) {
			const data = JSON.parse(deps.readFile(piAuthPath) ?? "{}");
			if (data["google-gemini-cli"]?.access) return data["google-gemini-cli"].access;
		}
	} catch {
		// Ignore parse errors
	}

	// Try ~/.gemini/oauth_creds.json
	const credPath = path.join(deps.homedir(), ".gemini", "oauth_creds.json");
	try {
		if (deps.fileExists(credPath)) {
			const data = JSON.parse(deps.readFile(credPath) ?? "{}");
			if (data.access_token) return data.access_token;
		}
	} catch {
		// Ignore parse errors
	}

	return undefined;
}

export class GeminiProvider extends BaseProvider {
	readonly name = "gemini" as const;
	readonly displayName = "Gemini Plan";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadGeminiToken(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<FetchResult> {
		const token = loadGeminiToken(deps);
		if (!token) {
			return this.result(this.emptySnapshot(noCredentials()));
		}

		const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);

		try {
			const res = await deps.fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: "{}",
				signal: controller.signal,
			});
			clear();

			if (!res.ok) {
				return this.result(this.emptySnapshot(httpError(res.status)), parseRetryAfter(res));
			}

			const data = (await res.json()) as {
				buckets?: Array<{
					modelId?: string;
					remainingFraction?: number;
				}>;
			};

			// Aggregate quotas by model type
			const quotas: Record<string, number> = {};
			for (const bucket of data.buckets || []) {
				const model = bucket.modelId || "unknown";
				const frac = bucket.remainingFraction ?? 1;
				if (!quotas[model] || frac < quotas[model]) {
					quotas[model] = frac;
				}
			}

			const windows: RateWindow[] = [];
			let proMin = 1;
			let flashMin = 1;
			let hasProModel = false;
			let hasFlashModel = false;

			for (const [model, frac] of Object.entries(quotas)) {
				if (model.toLowerCase().includes("pro")) {
					hasProModel = true;
					if (frac < proMin) proMin = frac;
				}
				if (model.toLowerCase().includes("flash")) {
					hasFlashModel = true;
					if (frac < flashMin) flashMin = frac;
				}
			}

			if (hasProModel) {
				windows.push({ label: "Pro", usedPercent: (1 - proMin) * 100 });
			}
			if (hasFlashModel) {
				windows.push({ label: "Flash", usedPercent: (1 - flashMin) * 100 });
			}

			return this.result(this.snapshot({ windows }));
		} catch {
			clear();
			return this.result(this.emptySnapshot(fetchFailed()));
		}
	}
}
