/**
 * File-based cache for usage data, shared across pi instances.
 *
 * Three files:
 *   cache.json  — good usage data, never overwritten with errors
 *   cache.lock  — short-lived, held during a fetch to prevent races
 *   backoff     — timestamp, written on 429/errors, prevents all instances from retrying
 *
 * Flow:
 *   1. Check cache → fresh good data? Done.
 *   2. Check backoff → too early to retry? Done, return undefined.
 *   3. Acquire lock → fetch.
 *   4. Success → write cache, delete backoff, release lock.
 *   5. Failure → write backoff (from Retry-After or default), release lock.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import type { FetchResult, ProviderName, UsageSnapshot } from "./types.js";

interface CacheEntry {
	fetchedAt: number;
	usage: UsageSnapshot;
}

type CacheFile = Partial<Record<ProviderName, CacheEntry>>;

const CACHE_DIR = path.join(getAgentDir(), "cache", "pi-usage");
const CACHE_PATH = path.join(CACHE_DIR, "cache.json");
const LOCK_PATH = path.join(CACHE_DIR, "cache.lock");
const BACKOFF_PATH = path.join(CACHE_DIR, "backoff");
const LOCK_STALE_MS = 5000;
const DEFAULT_BACKOFF_MS = 60_000;

function ensureDir(): void {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// --- Cache file ---

function readCacheFile(): CacheFile {
	try {
		const content = fs.readFileSync(CACHE_PATH, "utf-8");
		return JSON.parse(content) as CacheFile;
	} catch {
		return {};
	}
}

function writeCacheFile(cache: CacheFile): void {
	ensureDir();
	const tempPath = `${CACHE_PATH}.${process.pid}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(cache, null, 2), "utf-8");
	fs.renameSync(tempPath, CACHE_PATH);
}

// --- Lock file ---

function tryAcquireLock(): boolean {
	ensureDir();
	try {
		fs.writeFileSync(LOCK_PATH, String(Date.now()), { flag: "wx" });
		return true;
	} catch {
		try {
			const content = fs.readFileSync(LOCK_PATH, "utf-8");
			const lockTime = parseInt(content, 10);
			if (Date.now() - lockTime > LOCK_STALE_MS) {
				fs.writeFileSync(LOCK_PATH, String(Date.now()));
				return true;
			}
		} catch {
			// Ignore
		}
		return false;
	}
}

function releaseLock(): void {
	try {
		fs.unlinkSync(LOCK_PATH);
	} catch {
		// Ignore
	}
}

async function waitForLock(maxWaitMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!fs.existsSync(LOCK_PATH)) return true;
	}
	return false;
}

// --- Backoff file ---

function isBackingOff(): boolean {
	try {
		const content = fs.readFileSync(BACKOFF_PATH, "utf-8");
		const until = parseInt(content, 10);
		return Date.now() < until;
	} catch {
		return false;
	}
}

function writeBackoff(retryAfterMs?: number): void {
	ensureDir();
	const backoffMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_BACKOFF_MS;
	fs.writeFileSync(BACKOFF_PATH, String(Date.now() + backoffMs));
}

function clearBackoff(): void {
	try {
		fs.unlinkSync(BACKOFF_PATH);
	} catch {
		// Ignore
	}
}

// --- Public API ---

/**
 * Get fresh good usage data, or undefined if stale/missing.
 */
export function getGoodUsage(provider: ProviderName, ttlMs: number): UsageSnapshot | undefined {
	const cache = readCacheFile();
	const entry = cache[provider];
	if (!entry) return undefined;
	if (Date.now() - entry.fetchedAt >= ttlMs) return undefined;
	return entry.usage;
}

/**
 * Fetch usage with lock + backoff coordination.
 *
 * Returns good usage on success, undefined on error (caller keeps last good state).
 * On error, writes backoff so all instances wait before retrying.
 * Never overwrites good cache data with errors.
 */
export async function fetchWithCache(
	provider: ProviderName,
	ttlMs: number,
	fetchFn: () => Promise<FetchResult>,
): Promise<UsageSnapshot | undefined> {
	// Fresh good data — use it.
	const good = getGoodUsage(provider, ttlMs);
	if (good) return good;

	// Backing off from a previous error — don't retry.
	if (isBackingOff()) return undefined;

	// Need to fetch — acquire lock.
	const lockAcquired = tryAcquireLock();

	if (!lockAcquired) {
		// Another instance is fetching — wait for it.
		const released = await waitForLock(3000);
		if (released) {
			// Check if that instance got good data or set a backoff.
			const freshGood = getGoodUsage(provider, ttlMs);
			if (freshGood) return freshGood;
		}
		// Either timed out or other instance failed. Don't pile on.
		return undefined;
	}

	try {
		const result = await fetchFn();

		if (result.usage.error) {
			// Write backoff so all instances wait.
			writeBackoff(result.retryAfterMs);
			return undefined;
		}

		// Success — update cache and clear any backoff.
		const cache = readCacheFile();
		cache[provider] = { fetchedAt: Date.now(), usage: result.usage };
		writeCacheFile(cache);
		clearBackoff();

		return result.usage;
	} finally {
		if (lockAcquired) {
			releaseLock();
		}
	}
}

/**
 * Watch the cache file for changes from other pi instances.
 * Only fires onChange for good (non-error) data.
 */
export function watchCache(provider: ProviderName, onChange: (usage: UsageSnapshot) => void): () => void {
	let lastMtimeMs = 0;
	let lastContent = "";
	let stopped = false;

	const check = () => {
		if (stopped) return;
		try {
			const stat = fs.statSync(CACHE_PATH, { throwIfNoEntry: false });
			if (!stat || stat.mtimeMs === lastMtimeMs) return;
			if (fs.existsSync(LOCK_PATH)) return;
			lastMtimeMs = stat.mtimeMs;
			const content = fs.readFileSync(CACHE_PATH, "utf-8");
			if (content === lastContent) return;
			lastContent = content;
			const cache = JSON.parse(content) as CacheFile;
			const entry = cache[provider];
			if (entry?.usage && !entry.usage.error) {
				onChange(entry.usage);
			}
		} catch {
			// Ignore
		}
	};

	let watcher: fs.FSWatcher | undefined;
	try {
		ensureDir();
		if (!fs.existsSync(CACHE_PATH)) writeCacheFile({});
		watcher = fs.watch(CACHE_PATH, () => check());
		watcher.unref?.();
	} catch {
		// Fall back to polling only.
	}

	const pollTimer = setInterval(check, 5000);
	pollTimer.unref?.();

	return () => {
		stopped = true;
		watcher?.close();
		clearInterval(pollTimer);
	};
}
