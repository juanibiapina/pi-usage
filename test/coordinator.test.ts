import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createUsageCoordinator, getUsageStateDir } from "../src/coordinator.js";
import type { ProviderRefreshPolicy, UsageSnapshot } from "../src/types.js";

const policy: ProviderRefreshPolicy = {
	freshForMs: 60_000,
	defaultBackoffMs: 60_000,
	maxFetchMs: 10_000,
};

test("the machine state directory ignores Pi agent directories", () => {
	const first = getUsageStateDir(
		"linux",
		{ XDG_CACHE_HOME: "/machine-cache", PI_CODING_AGENT_DIR: "/agent-one" },
		"/home/test",
	);
	const second = getUsageStateDir(
		"linux",
		{ XDG_CACHE_HOME: "/machine-cache", PI_CODING_AGENT_DIR: "/agent-two" },
		"/home/test",
	);

	assert.equal(first, "/machine-cache/pi-usage");
	assert.equal(second, first);
});

function usage(percent: number): UsageSnapshot {
	return {
		provider: "anthropic",
		displayName: "Anthropic",
		windows: [{ label: "5h", usedPercent: percent }],
	};
}

test("a successful result is shared throughout the freshness window", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-coordinator-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let now = 1_000;
	let fetchCount = 0;
	const coordinator = createUsageCoordinator({ dir, now: () => now });

	const first = await coordinator.resolve("anthropic", policy, async () => {
		fetchCount += 1;
		return { ok: true, usage: usage(10) };
	});
	now += 30_000;
	const second = await coordinator.resolve("anthropic", policy, async () => {
		fetchCount += 1;
		return { ok: true, usage: usage(20) };
	});

	assert.equal(fetchCount, 1);
	assert.equal(first.availability, "available");
	assert.equal(first.freshness, "fresh");
	assert.equal(first.source, "endpoint");
	assert.equal(second.availability, "available");
	assert.equal(second.freshness, "fresh");
	assert.equal(second.source, "cache");
	assert.deepEqual(second.usage, usage(10));
});

test("concurrent coordinators share one same-provider endpoint result", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-coordinator-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let fetchCount = 0;
	let releaseFetch: (() => void) | undefined;
	const blocked = new Promise<void>((resolve) => {
		releaseFetch = resolve;
	});
	const first = createUsageCoordinator({ dir });
	const second = createUsageCoordinator({ dir });
	const fetcher = async () => {
		fetchCount += 1;
		await blocked;
		return { ok: true as const, usage: usage(42) };
	};

	const firstResult = first.resolve("anthropic", policy, fetcher);
	const secondResult = second.resolve("anthropic", policy, fetcher);
	await new Promise((resolve) => setTimeout(resolve, 25));
	releaseFetch?.();
	const results = await Promise.all([firstResult, secondResult]);

	assert.equal(fetchCount, 1);
	assert.equal(
		results.every((result) => result.availability === "available"),
		true,
	);
	assert.deepEqual(
		results.map((result) => (result.availability === "available" ? result.usage : undefined)),
		[usage(42), usage(42)],
	);
});

test("different providers resolve independently", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-coordinator-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const coordinator = createUsageCoordinator({ dir });
	let releaseAnthropic: (() => void) | undefined;
	const anthropicBlocked = new Promise<void>((resolve) => {
		releaseAnthropic = resolve;
	});
	const anthropic = coordinator.resolve("anthropic", policy, async () => {
		await anthropicBlocked;
		return { ok: true, usage: usage(10) };
	});

	const codex = await coordinator.resolve("codex", policy, async () => ({
		ok: true,
		usage: { ...usage(20), provider: "codex" },
	}));
	releaseAnthropic?.();
	await anthropic;

	assert.equal(codex.availability, "available");
	assert.equal(codex.availability === "available" && codex.source, "endpoint");
});

test("a failed refresh shares Retry-After and preserves last-good usage", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-coordinator-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let now = 1_000;
	let fetchCount = 0;
	const coordinator = createUsageCoordinator({ dir, now: () => now });
	await coordinator.resolve("anthropic", policy, async () => ({ ok: true, usage: usage(10) }));
	now += policy.freshForMs;

	const failed = await coordinator.resolve("anthropic", policy, async () => {
		fetchCount += 1;
		return {
			ok: false,
			error: { code: "HTTP_ERROR", message: "rate limited", httpStatus: 429 },
			retryAfterMs: 120_000,
		};
	});
	now += 30_000;
	const blocked = await createUsageCoordinator({ dir, now: () => now }).resolve("anthropic", policy, async () => {
		fetchCount += 1;
		return { ok: true, usage: usage(99) };
	});

	assert.equal(fetchCount, 1);
	assert.equal(failed.availability, "available");
	assert.equal(failed.availability === "available" && failed.freshness, "stale");
	assert.equal(failed.availability === "available" && failed.staleReason, "fetch-failed");
	assert.equal(blocked.availability, "available");
	assert.equal(blocked.availability === "available" && blocked.freshness, "stale");
	assert.equal(blocked.availability === "available" && blocked.staleReason, "backoff");
	assert.deepEqual(blocked.availability === "available" ? blocked.usage : undefined, usage(10));
});

test("a thrown provider failure preserves last-good usage and starts backoff", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-coordinator-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let now = 1_000;
	const coordinator = createUsageCoordinator({ dir, now: () => now });
	await coordinator.resolve("anthropic", policy, async () => ({ ok: true, usage: usage(10) }));
	now += policy.freshForMs;

	const result = await coordinator.resolve("anthropic", policy, async () => {
		throw new Error("network failed");
	});

	assert.equal(result.availability, "available");
	assert.equal(result.availability === "available" && result.freshness, "stale");
	assert.equal(result.availability === "available" && result.staleReason, "fetch-failed");
	assert.deepEqual(result.availability === "available" ? result.usage : undefined, usage(10));
});

test("twenty Pi processes with different agent directories share one endpoint request", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-coordinator-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let requestCount = 0;
	const server = createServer((_request, response) => {
		requestCount += 1;
		setTimeout(() => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(usage(73)));
		}, 250);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const endpoint = `http://127.0.0.1:${address.port}/usage`;
	const workerPath = fileURLToPath(new URL("fixtures/coordinator-worker.ts", import.meta.url));

	const workers = Array.from({ length: 20 }, (_, index) => {
		const child = fork(workerPath, [dir, endpoint], {
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "ignore", "inherit", "ipc"],
			env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, `agent-${index}`) },
		});
		t.after(() => child.kill());
		let readyResolve: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			readyResolve = resolve;
		});
		const result = new Promise<any>((resolve, reject) => {
			child.on("message", (message: any) => {
				if (message?.type === "ready") readyResolve?.();
				if (message?.type === "result") resolve(message.result);
				if (message?.type === "error") reject(new Error(message.error));
			});
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code && code !== 0) reject(new Error(`worker exited ${code}`));
			});
		});
		return { child, ready, result };
	});

	await Promise.all(workers.map((worker) => worker.ready));
	for (const worker of workers) worker.child.send("resolve");
	const results = await Promise.all(workers.map((worker) => worker.result));

	assert.equal(requestCount, 1);
	assert.equal(
		results.every((result) => result.availability === "available"),
		true,
	);
	assert.equal(
		results.every((result) => result.usage.windows[0]?.usedPercent === 73),
		true,
	);
});
