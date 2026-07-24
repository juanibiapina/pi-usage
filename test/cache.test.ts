import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCache } from "../src/cache.js";
import type { FetchResult, ProviderName, UsageSnapshot } from "../src/types.js";

function usage(provider: ProviderName): UsageSnapshot {
	return { provider, displayName: provider, windows: [] };
}

function success(provider: ProviderName): FetchResult {
	return { usage: usage(provider) };
}

function failure(provider: ProviderName, retryAfterMs?: number): FetchResult {
	return {
		usage: { ...usage(provider), error: { code: "HTTP_ERROR", message: "rate limited" } },
		retryAfterMs,
	};
}

async function createTestCache(t: test.TestContext, initialNow = 0) {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-cache-"));
	let currentNow = initialNow;
	t.after(async () => rm(dir, { recursive: true, force: true }));
	return {
		cache: createCache({ dir, now: () => currentNow }),
		advance: (milliseconds: number) => {
			currentNow += milliseconds;
		},
	};
}

test("an Anthropic backoff does not prevent a Codex fetch", async (t) => {
	const { cache } = await createTestCache(t);
	await cache.fetchWithCache("anthropic", 60_000, async () => failure("anthropic"));

	let codexFetched = false;
	const result = await cache.fetchWithCache("codex", 60_000, async () => {
		codexFetched = true;
		return success("codex");
	});

	assert.equal(codexFetched, true);
	assert.deepEqual(result, usage("codex"));
});

test("a Codex backoff prevents a Codex fetch", async (t) => {
	const { cache } = await createTestCache(t);
	await cache.fetchWithCache("codex", 60_000, async () => failure("codex"));

	let fetched = false;
	const result = await cache.fetchWithCache("codex", 60_000, async () => {
		fetched = true;
		return success("codex");
	});

	assert.equal(fetched, false);
	assert.equal(result, undefined);
});

test("a Codex success does not clear an Anthropic backoff", async (t) => {
	const { cache } = await createTestCache(t);
	await cache.fetchWithCache("anthropic", 60_000, async () => failure("anthropic"));
	await cache.fetchWithCache("codex", 60_000, async () => success("codex"));

	let anthropicFetched = false;
	await cache.fetchWithCache("anthropic", 60_000, async () => {
		anthropicFetched = true;
		return success("anthropic");
	});

	assert.equal(anthropicFetched, false);
});

test("fresh usage skips the fetch callback", async (t) => {
	const { cache } = await createTestCache(t);
	await cache.fetchWithCache("codex", 60_000, async () => success("codex"));

	let fetched = false;
	const result = await cache.fetchWithCache("codex", 60_000, async () => {
		fetched = true;
		return success("codex");
	});

	assert.equal(fetched, false);
	assert.deepEqual(result, usage("codex"));
});

test("a one-hour Codex Retry-After outlives the usage TTL", async (t) => {
	const { cache, advance } = await createTestCache(t);
	await cache.fetchWithCache("codex", 60_000, async () => failure("codex", 3_600_000));
	advance(61_000);

	let fetched = false;
	const result = await cache.fetchWithCache("codex", 60_000, async () => {
		fetched = true;
		return success("codex");
	});

	assert.equal(fetched, false);
	assert.equal(result, undefined);
});

test("a waiting provider retries after another provider fails", async (t) => {
	const { cache } = await createTestCache(t);
	let releaseAnthropic: (result: FetchResult) => void;
	const anthropicResult = new Promise<FetchResult>((resolve) => {
		releaseAnthropic = resolve;
	});
	let anthropicStarted: () => void;
	const started = new Promise<void>((resolve) => {
		anthropicStarted = resolve;
	});

	const anthropicFetch = cache.fetchWithCache("anthropic", 60_000, async () => {
		anthropicStarted();
		return anthropicResult;
	});
	await started;

	let codexFetched = false;
	const codexFetch = cache.fetchWithCache("codex", 60_000, async () => {
		codexFetched = true;
		return success("codex");
	});

	releaseAnthropic!(failure("anthropic"));
	await Promise.all([anthropicFetch, codexFetch]);

	assert.equal(codexFetched, true);
});
