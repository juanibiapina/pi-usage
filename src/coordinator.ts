import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isExpectedMissingData } from "./errors.js";
import type {
	ProviderFetchResult,
	ProviderName,
	ProviderRefreshPolicy,
	UsageError,
	UsageResolution,
	UsageSnapshot,
} from "./types.js";

interface ProviderState {
	version: 1;
	lastGood?: {
		fetchedAt: number;
		usage: UsageSnapshot;
	};
	retry?: {
		retryAt: number;
		failedAt: number;
		error: UsageError;
	};
}

interface ProviderLease {
	version: 1;
	token: string;
	pid: number;
	acquiredAt: number;
	expiresAt: number;
}

export interface UsageCoordinator {
	resolve(
		provider: ProviderName,
		policy: ProviderRefreshPolicy,
		fetcher: () => Promise<ProviderFetchResult>,
	): Promise<UsageResolution>;
}

export interface UsageCoordinatorOptions {
	dir: string;
	legacyDirs?: string[];
	now?: () => number;
}

export function getUsageStateDir(
	platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home = os.homedir(),
): string {
	if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "pi-usage");
	if (platform === "darwin") return path.join(home, "Library", "Caches", "pi-usage");
	return path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "pi-usage");
}

const LEASE_MINIMUM_MS = 30_000;
const LEASE_MARGIN_MS = 5_000;
const WAIT_POLL_MS = 10;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createUsageCoordinator({
	dir,
	legacyDirs = [],
	now = Date.now,
}: UsageCoordinatorOptions): UsageCoordinator {
	const statePath = (provider: ProviderName) => path.join(dir, `provider-${provider}.json`);
	const leasePath = (provider: ProviderName) => path.join(dir, `provider-${provider}.lock`);

	function ensureDir(): void {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
	}

	function readJson<T>(file: string): T | undefined {
		try {
			return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
		} catch {
			return undefined;
		}
	}

	function readState(provider: ProviderName): ProviderState {
		const state = readJson<ProviderState>(statePath(provider));
		return state?.version === 1 ? state : { version: 1 };
	}

	function writeState(provider: ProviderName, state: ProviderState): void {
		ensureDir();
		const target = statePath(provider);
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(state, null, "\t"), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(temporary, target);
	}

	function legacyCachePath(legacyDir: string, provider: ProviderName): string {
		return path.join(legacyDir, `cache-${provider}.json`);
	}

	function legacyBackoffPath(legacyDir: string, provider: ProviderName): string {
		return path.join(legacyDir, `backoff-${provider}`);
	}

	function hasLegacyState(provider: ProviderName): boolean {
		return legacyDirs.some(
			(legacyDir) =>
				fs.existsSync(legacyCachePath(legacyDir, provider)) ||
				fs.existsSync(legacyBackoffPath(legacyDir, provider)),
		);
	}

	function migrateLegacyState(provider: ProviderName, current: ProviderState): ProviderState {
		let next = current;
		const migratedPaths: string[] = [];
		for (const legacyDir of legacyDirs) {
			const cacheFile = legacyCachePath(legacyDir, provider);
			const legacyCache = readJson<{ fetchedAt?: number; usage?: UsageSnapshot }>(cacheFile);
			if (
				legacyCache?.usage &&
				!legacyCache.usage.error &&
				typeof legacyCache.fetchedAt === "number" &&
				(!next.lastGood || legacyCache.fetchedAt > next.lastGood.fetchedAt)
			) {
				next = { ...next, lastGood: { fetchedAt: legacyCache.fetchedAt, usage: legacyCache.usage } };
			}
			if (fs.existsSync(cacheFile)) migratedPaths.push(cacheFile);

			const backoffFile = legacyBackoffPath(legacyDir, provider);
			try {
				const retryAt = Number.parseInt(fs.readFileSync(backoffFile, "utf-8"), 10);
				if (Number.isFinite(retryAt) && retryAt > (next.retry?.retryAt ?? 0)) {
					next = {
						...next,
						retry: {
							retryAt,
							failedAt: Math.min(now(), retryAt),
							error: { code: "UNKNOWN", message: "Migrated provider backoff" },
						},
					};
				}
				migratedPaths.push(backoffFile);
			} catch {
				// No legacy backoff exists.
			}
		}

		if (migratedPaths.length > 0) {
			writeState(provider, next);
			for (const migratedPath of migratedPaths) fs.rmSync(migratedPath, { force: true });
		}
		return next;
	}

	function readLease(provider: ProviderName): ProviderLease | undefined {
		const lease = readJson<ProviderLease>(leasePath(provider));
		return lease?.version === 1 && typeof lease.token === "string" ? lease : undefined;
	}

	function acquireLease(provider: ProviderName, policy: ProviderRefreshPolicy): ProviderLease | undefined {
		ensureDir();
		const acquiredAt = now();
		const lease: ProviderLease = {
			version: 1,
			token: randomUUID(),
			pid: process.pid,
			acquiredAt,
			expiresAt: acquiredAt + Math.max(LEASE_MINIMUM_MS, policy.maxFetchMs + LEASE_MARGIN_MS),
		};
		const target = leasePath(provider);
		const serialized = JSON.stringify(lease);

		try {
			fs.writeFileSync(target, serialized, { encoding: "utf-8", flag: "wx", mode: 0o600 });
			return lease;
		} catch {
			const existing = readLease(provider);
			if (existing && existing.expiresAt > acquiredAt) return undefined;

			const stale = `${target}.${existing?.token ?? randomUUID()}.stale`;
			try {
				fs.renameSync(target, stale);
				fs.writeFileSync(target, serialized, { encoding: "utf-8", flag: "wx", mode: 0o600 });
				fs.rmSync(stale, { force: true });
				return lease;
			} catch {
				return undefined;
			}
		}
	}

	function releaseLease(provider: ProviderName, token: string): void {
		try {
			if (readLease(provider)?.token === token) fs.rmSync(leasePath(provider), { force: true });
		} catch {
			// A successor lease must remain untouched.
		}
	}

	async function waitForOwner(provider: ProviderName, policy: ProviderRefreshPolicy): Promise<boolean> {
		const waitUntil = Date.now() + Math.max(LEASE_MINIMUM_MS, policy.maxFetchMs + LEASE_MARGIN_MS) + LEASE_MARGIN_MS;
		while (Date.now() < waitUntil) {
			const lease = readLease(provider);
			if (!lease || lease.expiresAt <= now()) return true;
			await delay(WAIT_POLL_MS);
		}
		const lease = readLease(provider);
		return !lease || lease.expiresAt <= now();
	}

	function freshResolution(
		state: ProviderState,
		observedAt: number,
		source: "cache" | "endpoint" = "cache",
	): UsageResolution | undefined {
		if (!state.lastGood) return undefined;
		return {
			availability: "available",
			freshness: "fresh",
			source,
			usage: state.lastGood.usage,
			fetchedAt: state.lastGood.fetchedAt,
			observedAt,
		};
	}

	function blockedResolution(
		state: ProviderState,
		reason: "no-credentials" | "backoff" | "fetch-failed" | "lease-timeout",
		observedAt: number,
		error?: UsageError,
		retryAt?: number,
	): UsageResolution {
		if (state.lastGood) {
			return {
				availability: "available",
				freshness: "stale",
				source: "cache",
				usage: state.lastGood.usage,
				fetchedAt: state.lastGood.fetchedAt,
				observedAt,
				staleReason: reason,
				retryAt,
				error,
			};
		}
		return {
			availability: "unavailable",
			observedAt,
			reason,
			retryAt,
			error,
		};
	}

	function resolveFromState(
		state: ProviderState,
		policy: ProviderRefreshPolicy,
		observedAt: number,
	): UsageResolution | undefined {
		if (state.lastGood && observedAt - state.lastGood.fetchedAt < policy.freshForMs) {
			return freshResolution(state, observedAt);
		}
		if (state.retry && observedAt < state.retry.retryAt) {
			return blockedResolution(state, "backoff", observedAt, state.retry.error, state.retry.retryAt);
		}
		return undefined;
	}

	return {
		async resolve(provider, policy, fetcher) {
			for (let attempt = 0; attempt < 2; attempt++) {
				const observedAt = now();
				const state = readState(provider);
				const legacyPending = hasLegacyState(provider);
				const existing = resolveFromState(state, policy, observedAt);
				if (existing && !legacyPending) return existing;

				const lease = acquireLease(provider, policy);
				if (!lease) {
					if (await waitForOwner(provider, policy)) continue;
					return blockedResolution(readState(provider), "lease-timeout", now());
				}

				try {
					const protectedState = migrateLegacyState(provider, readState(provider));
					const protectedResult = resolveFromState(protectedState, policy, now());
					if (protectedResult) return protectedResult;

					let result: ProviderFetchResult;
					try {
						result = await fetcher();
					} catch (error) {
						result = {
							ok: false,
							error: {
								code: "FETCH_FAILED",
								message: error instanceof Error ? error.message : "Fetch failed",
							},
						};
					}
					if (result.ok) {
						const fetchedAt = now();
						const nextState: ProviderState = {
							version: 1,
							lastGood: { fetchedAt, usage: result.usage },
						};
						writeState(provider, nextState);
						return freshResolution(nextState, fetchedAt, "endpoint")!;
					}

					const failedAt = now();
					if (isExpectedMissingData(result.error)) {
						return blockedResolution(protectedState, "no-credentials", failedAt, result.error);
					}
					const retryAt = failedAt + (result.retryAfterMs ?? policy.defaultBackoffMs);
					const failedState: ProviderState = {
						version: 1,
						lastGood: protectedState.lastGood,
						retry: { retryAt, failedAt, error: result.error },
					};
					writeState(provider, failedState);
					return blockedResolution(failedState, "fetch-failed", failedAt, result.error, retryAt);
				} finally {
					releaseLease(provider, lease.token);
				}
			}

			return blockedResolution(readState(provider), "lease-timeout", now());
		},
	};
}
