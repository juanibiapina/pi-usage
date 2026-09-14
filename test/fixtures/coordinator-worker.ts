import { createUsageCoordinator } from "../../src/coordinator.js";
import type { ProviderRefreshPolicy, UsageSnapshot } from "../../src/types.js";

const [dir, endpoint] = process.argv.slice(2);
const policy: ProviderRefreshPolicy = {
	freshForMs: 60_000,
	defaultBackoffMs: 60_000,
	maxFetchMs: 10_000,
};

process.send?.({ type: "ready" });
process.on("message", async (message) => {
	if (message !== "resolve") return;
	try {
		const result = await createUsageCoordinator({ dir }).resolve("anthropic", policy, async () => {
			const response = await fetch(endpoint);
			if (!response.ok) {
				return {
					ok: false,
					error: { code: "HTTP_ERROR" as const, message: `HTTP ${response.status}`, httpStatus: response.status },
				};
			}
			return { ok: true, usage: (await response.json()) as UsageSnapshot };
		});
		process.send?.({ type: "result", result });
	} catch (error) {
		process.send?.({ type: "error", error: error instanceof Error ? error.message : String(error) });
	} finally {
		process.disconnect?.();
	}
});
