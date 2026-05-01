import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { computeRepScore } from "../engine.ts";
import { getCachedScore, setCachedScore, bustCache, getCacheStats } from "../cache.ts";
import { ScoreResponse, BatchScoreResponse } from "../types/index.ts";
import { webhookRouter } from "./webhook.ts";
const lookupLog: any[] = [];
const MAX_LOG = 500;
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

  // ── Lookup analytics ──────────────────────────────────────
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  console.log(JSON.stringify({
    event: "wallet_lookup",
    wallet,
    ip,
    userAgent,
    timestamp: new Date().toISOString(),
    forceRefresh,
  }));
  lookupLog.push({ wallet, ip, timestamp: new Date().toISOString() });
  if (lookupLog.length > MAX_LOG) lookupLog.shift();
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

// ── Analytics — recent lookups ────────────────────────────────


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
  });
});

function getTopWallets(log: any[]) {
  const counts: Record<string, number> = {};
  log.forEach(l => counts[l.wallet] = (counts[l.wallet] || 0) + 1);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([wallet, count]) => ({ wallet: wallet.slice(0,8) + '...', count }));
}

function getTopIps(log: any[]) {
  const counts: Record<string, number> = {};
  log.forEach(l => counts[l.ip] = (counts[l.ip] || 0) + 1);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ip, count]) => ({ ip, count }));
}

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
