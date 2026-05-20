/**
 * Provider registry — factory for creating provider instances.
 */

import type { UsageProvider } from "./provider.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { AntigravityProvider } from "./providers/antigravity.js";
import { CodexProvider } from "./providers/codex.js";
import { CopilotProvider } from "./providers/copilot.js";
import { GeminiProvider } from "./providers/gemini.js";
import { KiroProvider } from "./providers/kiro.js";
import { ZaiProvider } from "./providers/zai.js";
import type { Dependencies, ProviderName } from "./types.js";

const FACTORIES: Record<ProviderName, () => UsageProvider> = {
	anthropic: () => new AnthropicProvider(),
	copilot: () => new CopilotProvider(),
	gemini: () => new GeminiProvider(),
	antigravity: () => new AntigravityProvider(),
	codex: () => new CodexProvider(),
	kiro: () => new KiroProvider(),
	zai: () => new ZaiProvider(),
};

export function createProvider(name: ProviderName): UsageProvider {
	return FACTORIES[name]();
}

export function hasCredentials(name: ProviderName, deps: Dependencies): boolean {
	const provider = createProvider(name);
	return provider.hasCredentials ? provider.hasCredentials(deps) : true;
}
