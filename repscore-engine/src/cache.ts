// ============================================================
// RepScore Engine — Cache Layer
// Redis-backed with in-memory fallback
// ============================================================

import { RepScore } from "./types/index.js";

const CACHE_TTL_SECONDS = 60 * 30; // 30 minutes
const CACHE_PREFIX = "repscore:v1:";

// ── In-memory fallback (used when Redis not available) ────────

const memCache = new Map<string, { data: RepScore; expiresAt: number }>();

// ── Redis client (optional) ───────────────────────────────────

let redis: any = null;

async function getRedis() {
  if (redis) return redis;
  if (!process.env.REDIS_URL) return null;

  try {
    const { createClient } = await import("redis");
    redis = createClient({ url: process.env.REDIS_URL });
    redis.on("error", (err: any) => {
      console.warn("[Cache] Redis error, falling back to memory:", err.message);
      redis = null;
    });
    await redis.connect();
    console.log("[Cache] Redis connected");
    return redis;
  } catch (err) {
    console.warn("[Cache] Redis unavailable, using in-memory cache");
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────

export async function getCachedScore(wallet: string): Promise<RepScore | null> {
  const key = CACHE_PREFIX + wallet;

  // Try Redis first
  const client = await getRedis();
  if (client) {
    try {
      const raw = await client.get(key);
      if (raw) {
        console.log(`[Cache] Redis hit: ${wallet.slice(0, 8)}...`);
        return JSON.parse(raw) as RepScore;
      }
    } catch (err) {
      console.warn("[Cache] Redis get failed:", err);
    }
  }

  // Fall back to memory
  const mem = memCache.get(key);
  if (mem && mem.expiresAt > Date.now()) {
    console.log(`[Cache] Memory hit: ${wallet.slice(0, 8)}...`);
    return mem.data;
  }

  if (mem) memCache.delete(key); // expired
  return null;
}

export async function setCachedScore(
  wallet: string,
  score: RepScore
): Promise<void> {
  const key = CACHE_PREFIX + wallet;
  const serialized = JSON.stringify(score);

  // Try Redis first
  const client = await getRedis();
  if (client) {
    try {
      await client.setEx(key, CACHE_TTL_SECONDS, serialized);
      return;
    } catch (err) {
      console.warn("[Cache] Redis set failed:", err);
    }
  }

  // Fall back to memory
  memCache.set(key, {
    data: score,
    expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
  });

  // Prevent memory leak — cap at 1000 entries
  if (memCache.size > 1000) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey) memCache.delete(oldestKey);
  }
}

export async function bustCache(wallet: string): Promise<void> {
  const key = CACHE_PREFIX + wallet;
  const client = await getRedis();
  if (client) {
    try { await client.del(key); } catch {}
  }
  memCache.delete(key);
}

export async function getCacheStats(): Promise<{
  backend: string;
  memoryEntries: number;
  ttlSeconds: number;
}> {
  const client = await getRedis();
  return {
    backend: client ? "redis" : "memory",
    memoryEntries: memCache.size,
    ttlSeconds: CACHE_TTL_SECONDS,
  };
}
