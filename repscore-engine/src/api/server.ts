// ============================================================
// RepScore Engine — API Server
// REST endpoints for repscore.xyz
// ============================================================

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { computeRepScore } from "../engine.ts";
import { getCachedScore, setCachedScore, bustCache, getCacheStats } from "../cache.ts";
import { ScoreResponse, BatchScoreResponse } from "../types/index.ts";
import { webhookRouter } from "./webhook.ts";

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────

app.use(cors({
  origin: [
    "https://repscore.xyz",
    "https://www.repscore.xyz",
    "https://fortressofsolitude.pro",
    ...(process.env.NODE_ENV === "development" ? ["http://localhost:3000", "http://localhost:5173"] : []),
  ],
  methods: ["GET", "POST"],
}));

// ── Rate limiting ─────────────────────────────────────────────

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 30,                   // 30 req/min for unauthenticated
  message: { error: "Rate limit exceeded. Add an API key for higher limits." },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,                  // 300 req/min for API key holders
  keyGenerator: (req) => req.headers["x-api-key"] as string || req.ip || "unknown",
  skip: (req) => !req.headers["x-api-key"],
});

// ── API Key middleware ─────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"];
  if (!key || !isValidApiKey(key as string)) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }
  next();
}

function isValidApiKey(key: string): boolean {
  // In production: check against database. For now, env-based.
  const validKeys = (process.env.API_KEYS || "").split(",").filter(Boolean);
  return validKeys.includes(key);
}

// ── Wallet validation ─────────────────────────────────────────

function isValidSolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// ── Supabase persistent logging ───────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

async function logToSupabase(data: {
  wallet: string;
  ip: string;
  visitor_id: string;
  fingerprint: string;
}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('[Supabase] Missing URL or KEY');
    return;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/wallet_lookups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn('[Supabase] Write failed:', res.status, text);
    } else {
      console.log('[Supabase] ✓ Logged:', data.wallet.slice(0, 8) + '...');
    }
  } catch (err: any) {
    console.warn('[Supabase] Error:', err.message);
  }
}

// ── Score snapshot logging ────────────────────────────────────

async function logScoreSnapshot(wallet: string, score: any) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/score_history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        wallet,
        score: score.score,
        tier: score.tier,
        launch_history_raw: score.components.launchHistory.raw,
        liquidity_raw: score.components.liquidityBehavior.raw,
        holder_retention_raw: score.components.holderRetention.raw,
        community_raw: score.components.communitySignals.raw,
        wallet_history_raw: score.components.walletHistory.raw,
        flag_count: score.flags.length,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn('[Supabase] Snapshot failed:', res.status, text);
    } else {
      console.log('[Supabase] ✓ Snapshot saved:', wallet.slice(0,8) + '...');
    }
  } catch (err: any) {
    console.warn('[Supabase] Snapshot error:', err.message);
  }
}


// ── Leaderboard upsert ────────────────────────────────────────

async function upsertLeaderboard(wallet: string, score: any) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/leaderboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        wallet,
        score: score.score,
        tier: score.tier,
        role: score.role,
        total_launches: score.metadata.totalLaunches,
        graduated_count: score.metadata.graduatedCount,
        flag_count: score.flags.length,
        last_scored_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (err: any) {
    console.warn('[Supabase] Leaderboard upsert failed:', err.message);
  }
}

// ── In-memory analytics log ───────────────────────────────────

const lookupLog: any[] = [];
const MAX_LOG = 500;

// ── Routes ────────────────────────────────────────────────────

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
});

// Cache stats (internal)
app.get("/internal/cache-stats", async (_req, res) => {
  const stats = await getCacheStats();
  res.json(stats);
});

// GET /v1/score/:wallet — single wallet score (public, rate limited)
app.get("/v1/score/:wallet", publicLimiter, apiKeyLimiter, async (req, res) => {
  const { wallet } = req.params;
  const forceRefresh = req.query.refresh === "true";

  if (!isValidSolanaAddress(wallet)) {
    res.status(400).json({ success: false, error: "Invalid Solana wallet address" } as ScoreResponse);
    return;
  }

  // ── Lookup tracking ───────────────────────────────────────
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress || 'unknown';
  const visitorId   = req.headers['x-visitor-id'] as string || 'unknown';
  const fingerprint = req.headers['x-fingerprint'] as string || 'unknown';

  lookupLog.push({ wallet, ip, visitorId, fingerprint, timestamp: new Date().toISOString() });
  if (lookupLog.length > MAX_LOG) lookupLog.shift();

  logToSupabase({ wallet, ip, visitor_id: visitorId, fingerprint });

  try {
    // Check cache unless force refresh
    if (!forceRefresh) {
      const cached = await getCachedScore(wallet);
      if (cached) {
        res.json({ success: true, data: cached, fromCache: true } as ScoreResponse);
        return;
      }
    }

    // Compute fresh score
    console.log(`[API] Computing score for ${wallet.slice(0, 8)}...`);
    const score = await computeRepScore(wallet);
    await setCachedScore(wallet, score);
    logScoreSnapshot(wallet, score);
    upsertLeaderboard(wallet, score);

    res.json({ success: true, data: score, fromCache: false } as ScoreResponse);
  } catch (err: any) {
    console.error("[API] Score error:", err.message);
    res.status(500).json({ success: false, error: err.message } as ScoreResponse);
  }
});

// POST /v1/score/batch — batch scoring (API key required)
app.post("/v1/score/batch", requireApiKey, async (req, res) => {
  const { wallets, forceRefresh = false } = req.body as {
    wallets: string[];
    forceRefresh?: boolean;
  };

  if (!Array.isArray(wallets) || wallets.length === 0) {
    res.status(400).json({ success: false, results: {}, errors: { input: "wallets must be a non-empty array" } });
    return;
  }

  if (wallets.length > 50) {
    res.status(400).json({ success: false, results: {}, errors: { input: "Max 50 wallets per batch request" } });
    return;
  }

  const results: BatchScoreResponse["results"] = {};
  const errors: BatchScoreResponse["errors"] = {};

  await Promise.allSettled(
    wallets.map(async (wallet) => {
      if (!isValidSolanaAddress(wallet)) {
        errors[wallet] = "Invalid Solana address";
        return;
      }

      try {
        let score = forceRefresh ? null : await getCachedScore(wallet);
        const fromCache = !!score;

        if (!score) {
          score = await computeRepScore(wallet);
          await setCachedScore(wallet, score);
        }

        results[wallet] = { success: true, data: score, fromCache };
      } catch (err: any) {
        errors[wallet] = err.message;
      }
    })
  );

  res.json({ success: true, results, errors } satisfies BatchScoreResponse);
});

// POST /v1/score/:wallet/refresh — force bust cache + rescore
app.post("/v1/score/:wallet/refresh", requireApiKey, async (req, res) => {
  const { wallet } = req.params;
  if (!isValidSolanaAddress(wallet)) {
    res.status(400).json({ success: false, error: "Invalid Solana wallet address" });
    return;
  }
  try {
    await bustCache(wallet);
    const score = await computeRepScore(wallet);
    await setCachedScore(wallet, score);
    res.json({ success: true, data: score, fromCache: false });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Webhook routes ────────────────────────────────────────────

app.use("/webhooks", webhookRouter);

// ── Analytics endpoint ────────────────────────────────────────

app.get("/internal/lookups", async (req, res) => {
  const secret = req.headers["x-internal-secret"];
  if (secret !== process.env.INTERNAL_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({
    total: lookupLog.length,
    recent: lookupLog.slice(-50),
    topWallets: getTopWallets(lookupLog),
    topIps: getTopIps(lookupLog),
    topVisitors: getTopVisitors(lookupLog),
    topFingerprints: getTopFingerprints(lookupLog),
  });
});

function getTopWallets(log: any[]) {
  const counts: Record<string, number> = {};
  log.forEach(l => counts[l.wallet] = (counts[l.wallet] || 0) + 1);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([wallet, count]) => ({ wallet: wallet.slice(0, 8) + '...', count }));
}

function getTopIps(log: any[]) {
  const counts: Record<string, number> = {};
  log.forEach(l => counts[l.ip] = (counts[l.ip] || 0) + 1);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([ip, count]) => ({ ip, count }));
}

function getTopVisitors(log: any[]) {
  const counts: Record<string, { count: number; wallets: Set<string> }> = {};
  log.forEach(l => {
    if (!counts[l.visitorId]) counts[l.visitorId] = { count: 0, wallets: new Set() };
    counts[l.visitorId].count++;
    counts[l.visitorId].wallets.add(l.wallet);
  });
  return Object.entries(counts).sort((a, b) => b[1].count - a[1].count).slice(0, 10)
    .map(([visitorId, data]) => ({ visitorId, lookups: data.count, uniqueWallets: data.wallets.size }));
}

function getTopFingerprints(log: any[]) {
  const counts: Record<string, { count: number; wallets: Set<string>; ips: Set<string> }> = {};
  log.forEach(l => {
    if (l.fingerprint === 'unknown') return;
    if (!counts[l.fingerprint]) counts[l.fingerprint] = { count: 0, wallets: new Set(), ips: new Set() };
    counts[l.fingerprint].count++;
    counts[l.fingerprint].wallets.add(l.wallet);
    counts[l.fingerprint].ips.add(l.ip);
  });
  return Object.entries(counts).sort((a, b) => b[1].count - a[1].count).slice(0, 10)
    .map(([fingerprint, data]) => ({ fingerprint, lookups: data.count, uniqueWallets: data.wallets.size, uniqueIps: data.ips.size }));
}

// ── Score history endpoint ───────────────────────────────────

app.get("/v1/history/:wallet", async (req, res) => {
  const { wallet } = req.params;
  if (!isValidSolanaAddress(wallet)) {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(503).json({ error: "History unavailable" });
    return;
  }
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/score_history?wallet=eq.${wallet}&order=created_at.asc&limit=90`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const data = await response.json();
    res.json({ success: true, history: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leaderboard endpoint ─────────────────────────────────────

app.get("/v1/leaderboard", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(503).json({ error: "Leaderboard unavailable" });
    return;
  }
  try {
    const limit = Math.min(parseInt(req.query.limit as string || "100"), 100);
    const tier  = req.query.tier as string || '';

    let url = `${SUPABASE_URL}/rest/v1/leaderboard?order=score.desc&limit=${limit}`;
    if (tier) url += `&tier=eq.${tier}`;

    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });
    const data = await response.json();
    res.json({
      success: true,
      leaderboard: data,
      total: data.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── 404 Handler ───────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Start ─────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001");
app.listen(PORT, () => {
  console.log(`[RepScore API] Running on port ${PORT}`);
  console.log(`[RepScore API] Helius key: ${process.env.HELIUS_API_KEY ? "✓" : "✗ MISSING"}`);
  console.log(`[RepScore API] Redis: ${process.env.REDIS_URL ? "✓" : "not configured (using memory)"}`);
});

export default app;
