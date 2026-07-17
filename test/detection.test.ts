import assert from "node:assert/strict";
import test from "node:test";
import { detectProvider } from "../src/detection.js";

// Anthropic
test("detects Anthropic by provider", () => {
	assert.equal(detectProvider({ provider: "anthropic", id: "claude-sonnet-4" }), "anthropic");
});

test("detects Anthropic case-insensitive", () => {
	assert.equal(detectProvider({ provider: "Anthropic", id: "claude-sonnet-4" }), "anthropic");
});

test("detects Anthropic by model token when provider missing", () => {
	assert.equal(detectProvider({ id: "claude-sonnet-4" }), "anthropic");
});

// Bedrock fix
test("rejects Bedrock provider even with claude model", () => {
	assert.equal(detectProvider({ provider: "bedrock", id: "claude-sonnet-4" }), undefined);
});

test("rejects Amazon Bedrock provider", () => {
	assert.equal(detectProvider({ provider: "amazon-bedrock", id: "anthropic.claude-3-sonnet" }), undefined);
});

// Other providers
test("detects Copilot by provider", () => {
	assert.equal(detectProvider({ provider: "github", id: "copilot-model" }), "copilot");
});

test("detects Gemini by provider", () => {
	assert.equal(detectProvider({ provider: "google", id: "gemini-2.5-pro" }), "gemini");
});

test("detects Gemini by model token when provider missing", () => {
	assert.equal(detectProvider({ id: "gemini-2.5-pro" }), "gemini");
});

test("detects Codex by provider", () => {
	assert.equal(detectProvider({ provider: "openai", id: "gpt-5" }), "codex");
});

test("detects Antigravity by provider", () => {
	assert.equal(detectProvider({ provider: "antigravity", id: "some-model" }), "antigravity");
});

test("detects Antigravity by model token (special case)", () => {
	assert.equal(detectProvider({ id: "antigravity-model" }), "antigravity");
});

test("detects Kiro by provider", () => {
	assert.equal(detectProvider({ provider: "kiro", id: "some-model" }), "kiro");
});

test("detects z.ai by provider", () => {
	assert.equal(detectProvider({ provider: "z.ai", id: "model" }), "zai");
});

test("detects xAI by provider", () => {
	assert.equal(detectProvider({ provider: "xai", id: "grok-4.5" }), "xai");
});

test("detects xAI by model token when provider missing", () => {
	assert.equal(detectProvider({ id: "grok-4.5" }), "xai");
});

test("does not map xai provider token to z.ai", () => {
	assert.equal(detectProvider({ provider: "xai", id: "anything" }), "xai");
});

// Edge cases
test("returns undefined for unknown provider", () => {
	assert.equal(detectProvider({ provider: "unknown-provider", id: "unknown-model" }), undefined);
});

test("returns undefined for undefined model", () => {
	assert.equal(detectProvider(undefined), undefined);
});

test("returns undefined for empty model", () => {
	assert.equal(detectProvider({}), undefined);
});

// Provider token takes priority over model token
test("provider token wins over model token", () => {
	assert.equal(detectProvider({ provider: "openai", id: "claude-3-opus" }), "codex");
});
