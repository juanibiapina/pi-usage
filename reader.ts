import { createUsageCoordinator, getUsageStateDir } from "./src/coordinator.js";
import { createDefaultDependencies } from "./src/dependencies.js";
import { createUsageReader } from "./src/reader.js";
import type { ProviderName, UsageResolution } from "./src/types.js";

export type {
	ProviderName,
	UsageError,
	UsageResolution,
	UsageSnapshot,
} from "./src/types.js";

const productionReader = createUsageReader(
	createDefaultDependencies(),
	createUsageCoordinator({ dir: getUsageStateDir() }),
);

export function getUsage(provider: ProviderName): Promise<UsageResolution> {
	return productionReader.getUsage(provider);
}
