import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUsageCoordinator } from "../src/coordinator.js";
import { createUsageReader } from "../src/reader.js";
import type { Dependencies } from "../src/types.js";

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
	return {
		fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
		readFile: () => undefined,
		fileExists: () => false,
		execFileSync: () => "",
		homedir: () => "/tmp/pi-usage-reader-home",
		env: {},
		...overrides,
	};
}

test("the package reader subpath exposes the production usage reader", async () => {
	const publicReader = await import("@juanibiapina/pi-usage/reader");

	assert.equal(typeof publicReader.getUsage, "function");
});

test("a provider without credentials resolves unavailable without an endpoint request", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-reader-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let requests = 0;
	const reader = createUsageReader(
		dependencies({
			fetch: async () => {
				requests += 1;
				return new Response(JSON.stringify({}), { status: 200 });
			},
		}),
		createUsageCoordinator({ dir }),
	);

	const result = await reader.getUsage("anthropic");

	assert.equal(requests, 0);
	assert.equal(result.availability, "unavailable");
	assert.equal(result.availability === "unavailable" && result.reason, "no-credentials");
	assert.equal(result.error?.code, "NO_CREDENTIALS");
});

test("a supported provider resolves usage through its provider and coordinator", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-usage-reader-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const reader = createUsageReader(
		dependencies({
			fileExists: (file) => file.includes("auth.json"),
			readFile: (file) =>
				file.includes("auth.json") ? JSON.stringify({ anthropic: { access: "test-token" } }) : undefined,
			fetch: async () =>
				new Response(
					JSON.stringify({
						five_hour: { utilization: 37 },
						seven_day: { utilization: 12 },
					}),
					{ status: 200 },
				),
		}),
		createUsageCoordinator({ dir, now: () => 1_000 }),
	);

	const result = await reader.getUsage("anthropic");

	assert.equal(result.availability, "available");
	assert.equal(result.availability === "available" && result.source, "endpoint");
	assert.deepEqual(result.availability === "available" ? result.usage.windows : undefined, [
		{ label: "5h", usedPercent: 37, resetDescription: undefined, resetAt: undefined },
		{ label: "Week", usedPercent: 12, resetDescription: undefined, resetAt: undefined },
	]);
});
