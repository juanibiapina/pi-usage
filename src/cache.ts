/**
 * File-based cache for usage data, shared across pi instances.
 *
 * Each provider has its own cache and backoff file. A shared fetch lock avoids
 * simultaneous requests while owner tokens ensure a stale lock holder cannot
 * release a newer lock.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { FetchResult, ProviderName, UsageSnapshot } from "./types.js";

interface CacheEntry {
	fetchedAt: number;
	usage: UsageSnapshot;
}

interface LockFile {
	token: string;
	acquiredAt: number;
}

export interface CacheOperations {
	getGoodUsage(provider: ProviderName, ttlMs: number): UsageSnapshot | undefined;
	fetchWithCache(
		provider: ProviderName,
		ttlMs: number,
		fetchFn: () => Promise<FetchResult>,
	): Promise<UsageSnapshot | undefined>;
	watchCache(provider: ProviderName, onChange: (usage: UsageSnapshot) => void): () => void;
}

export interface CacheOptions {
	dir: string;
	now?: () => number;
}

const LOCK_STALE_MS = 5000;
const DEFAULT_BACKOFF_MS = 60_000;

export function createCache({ dir, now = Date.now }: CacheOptions): CacheOperations {
	const lockPath = path.join(dir, "cache.lock");
	const cachePath = (provider: ProviderName) => path.join(dir, `cache-${provider}.json`);
	const backoffPath = (provider: ProviderName) => path.join(dir, `backoff-${provider}`);

	function ensureDir(): void {
		fs.mkdirSync(dir, { recursive: true });
	}

	function readCacheFile(provider: ProviderName): CacheEntry | undefined {
		try {
			return JSON.parse(fs.readFileSync(cachePath(provider), "utf-8")) as CacheEntry;
		} catch {
			return undefined;
		}
	}

	function writeCacheFile(provider: ProviderName, entry: CacheEntry): void {
		ensureDir();
		const target = cachePath(provider);
		const tempPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
		fs.writeFileSync(tempPath, JSON.stringify(entry, null, 2), "utf-8");
		fs.renameSync(tempPath, target);
	}

	function readLock(): LockFile | undefined {
		try {
			const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockFile;
			return typeof lock.token === "string" && typeof lock.acquiredAt === "number" ? lock : undefined;
		} catch {
			return undefined;
		}
	}

	function tryAcquireLock(): string | undefined {
		ensureDir();
		const token = randomUUID();
		const lock = JSON.stringify({ token, acquiredAt: now() });

		try {
			fs.writeFileSync(lockPath, lock, { flag: "wx" });
			return token;
		} catch {
			const existing = readLock();
			if (!existing || now() - existing.acquiredAt <= LOCK_STALE_MS) return undefined;

			try {
				// Renaming removes the stale path. An old owner can no longer remove a
				// replacement lock because releaseLock verifies its token first.
				fs.renameSync(lockPath, `${lockPath}.${existing.token}.stale`);
				fs.writeFileSync(lockPath, lock, { flag: "wx" });
				return token;
			} catch {
				return undefined;
			}
		}
	}

	function releaseLock(token: string): void {
		try {
			if (readLock()?.token === token) fs.unlinkSync(lockPath);
		} catch {
			// Ignore cleanup failures.
		}
	}

	async function waitForLock(maxWaitMs: number): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < maxWaitMs) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			if (!fs.existsSync(lockPath)) return true;
		}
		return false;
	}

	function isBackingOff(provider: ProviderName): boolean {
		try {
			const until = parseInt(fs.readFileSync(backoffPath(provider), "utf-8"), 10);
			return now() < until;
		} catch {
			return false;
		}
	}

	function writeBackoff(provider: ProviderName, retryAfterMs?: number): void {
		ensureDir();
		const backoffMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_BACKOFF_MS;
		fs.writeFileSync(backoffPath(provider), String(now() + backoffMs));
	}

	function clearBackoff(provider: ProviderName): void {
		try {
			fs.unlinkSync(backoffPath(provider));
		} catch {
			// Ignore missing backoffs.
		}
	}

	function getGoodUsage(provider: ProviderName, ttlMs: number): UsageSnapshot | undefined {
		const entry = readCacheFile(provider);
		if (!entry || now() - entry.fetchedAt >= ttlMs) return undefined;
		return entry.usage;
	}

	async function fetchWithCache(
		provider: ProviderName,
		ttlMs: number,
		fetchFn: () => Promise<FetchResult>,
	): Promise<UsageSnapshot | undefined> {
		for (let attempts = 0; attempts < 2; attempts++) {
			const good = getGoodUsage(provider, ttlMs);
			if (good) return good;
			if (isBackingOff(provider)) return undefined;

			const lockToken = tryAcquireLock();
			if (!lockToken) {
				const released = await waitForLock(3000);
				if (!released) return undefined;
				continue;
			}

			try {
				const result = await fetchFn();
				if (result.usage.error) {
					writeBackoff(provider, result.retryAfterMs);
					return undefined;
				}

				writeCacheFile(provider, { fetchedAt: now(), usage: result.usage });
				clearBackoff(provider);
				return result.usage;
			} catch {
				writeBackoff(provider);
				return undefined;
			} finally {
				releaseLock(lockToken);
			}
		}

		return undefined;
	}

	function watchCache(provider: ProviderName, onChange: (usage: UsageSnapshot) => void): () => void {
		let lastMtimeMs = 0;
		let stopped = false;
		const watchedFile = path.basename(cachePath(provider));

		const check = () => {
			if (stopped || fs.existsSync(lockPath)) return;
			try {
				const stat = fs.statSync(cachePath(provider), { throwIfNoEntry: false });
				if (!stat || stat.mtimeMs === lastMtimeMs) return;
				lastMtimeMs = stat.mtimeMs;
				const entry = readCacheFile(provider);
				if (entry?.usage && !entry.usage.error) onChange(entry.usage);
			} catch {
				// Ignore concurrent writes and malformed files.
			}
		};

		ensureDir();
		let watcher: fs.FSWatcher | undefined;
		try {
			watcher = fs.watch(dir, (_event, filename) => {
				if (filename?.toString() === watchedFile) check();
			});
			watcher.unref?.();
		} catch {
			// Polling below covers filesystems without watch support.
		}

		const pollTimer = setInterval(check, 5000);
		pollTimer.unref?.();
		return () => {
			stopped = true;
			watcher?.close();
			clearInterval(pollTimer);
		};
	}

	return { getGoodUsage, fetchWithCache, watchCache };
}

export const productionCache = createCache({ dir: path.join(getAgentDir(), "cache", "pi-usage") });

export const { getGoodUsage, fetchWithCache, watchCache } = productionCache;
