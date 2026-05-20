/**
 * Detect which subscription provider the current model belongs to.
 *
 * Fix vs pi-sub-core: when model.provider is explicitly set and doesn't match
 * any known provider's providerTokens, we return undefined instead of falling
 * back to model token matching. This prevents false positives like AWS Bedrock
 * (provider="bedrock", model="claude-*") being misidentified as Anthropic.
 */

import type { ProviderName } from "./types.js";

interface DetectionHint {
	provider: ProviderName;
	providerTokens: string[];
	modelTokens: string[];
}

const DETECTION_HINTS: DetectionHint[] = [
	{ provider: "anthropic", providerTokens: ["anthropic"], modelTokens: ["claude"] },
	{ provider: "copilot", providerTokens: ["copilot", "github"], modelTokens: [] },
	{ provider: "gemini", providerTokens: ["google", "gemini"], modelTokens: ["gemini"] },
	{ provider: "antigravity", providerTokens: ["antigravity"], modelTokens: ["antigravity"] },
	{ provider: "codex", providerTokens: ["openai", "codex"], modelTokens: ["gpt", "o1", "o3"] },
	{ provider: "kiro", providerTokens: ["kiro", "aws"], modelTokens: [] },
	{ provider: "zai", providerTokens: ["zai", "z.ai", "xai"], modelTokens: [] },
];

export function detectProvider(model: { provider?: string; id?: string } | undefined): ProviderName | undefined {
	if (!model) return undefined;

	const providerValue = model.provider?.toLowerCase() ?? "";
	const idValue = model.id?.toLowerCase() ?? "";

	// Antigravity special case (original pi-sub-core behavior).
	if (providerValue.includes("antigravity") || idValue.includes("antigravity")) {
		return "antigravity";
	}

	// Match on provider tokens first.
	for (const hint of DETECTION_HINTS) {
		if (hint.providerTokens.some((token) => providerValue.includes(token))) {
			return hint.provider;
		}
	}

	// FIX: Only fall back to model tokens when provider is empty/unset.
	// If provider was explicitly set (e.g. "bedrock") but didn't match any
	// known provider above, the model is NOT on a known subscription.
	if (providerValue) {
		return undefined;
	}

	// No provider set — try model tokens.
	for (const hint of DETECTION_HINTS) {
		if (hint.modelTokens.some((token) => idValue.includes(token))) {
			return hint.provider;
		}
	}

	return undefined;
}
