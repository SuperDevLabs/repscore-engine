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
import { sendScoreChangeAlert, sendVerificationEmail } from "../email.js";

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────

app.use(cors({
  origin: [
    'https://repscore.xyz',
    'https://www.repscore.xyz',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-api-key',
    'x-visitor-id',
    'x-fingerprint',
    'x-internal-secret'
  ]
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
    checkWatchlistChanges(wallet, score);

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

// ── Token lookup endpoint ─────────────────────────────────────
// Finds deployer wallet from mint address and returns their score

app.get("/v1/token/:mint", publicLimiter, async (req, res) => {
  const { mint } = req.params;

  if (!isValidSolanaAddress(mint)) {
    res.status(400).json({ success: false, error: "Invalid mint address" });
    return;
  }

  try {
    let deployer: string | null = null;

    // Strategy 1: Check mint authority (works for non-graduated tokens)
    try {
      const heliusRes = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1,
            method: "getAccountInfo",
            params: [mint, { encoding: "jsonParsed" }],
          }),
        }
      );
      const heliusData = await heliusRes.json();
      const mintInfo = heliusData?.result?.value?.data?.parsed?.info;
      if (mintInfo?.mintAuthority) {
        deployer = mintInfo.mintAuthority;
        console.log(`[Token] ${mint.slice(0,8)}... deployer from mintAuthority: ${deployer?.slice(0,8)}`);
      }
    } catch {}

    // Strategy 2: Get ALL signatures and find the oldest (token creation tx)
    // pump.fun graduated tokens have null mintAuthority so we need this
    if (!deployer) {
      try {
        const sigsRes = await fetch(
          `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1,
              method: "getSignaturesForAddress",
              params: [mint, { limit: 1000, commitment: "finalized" }],
            }),
          }
        );
        const sigsData = await sigsRes.json();
        const sigs = sigsData?.result || [];

        if (sigs.length > 0) {
          // Oldest = last item = token creation
          const oldestSig = sigs[sigs.length - 1].signature;
          const txRes = await fetch(
            `https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ transactions: [oldestSig] }),
            }
          );
          const txData = await txRes.json();
          const tx = txData?.[0];
          if (tx?.feePayer) {
            deployer = tx.feePayer;
            console.log(`[Token] ${mint.slice(0,8)}... deployer from oldest tx feePayer: ${deployer?.slice(0,8)}`);
          }
        }
      } catch {}
    }

    // Strategy 3: DexScreener — sometimes has maker/deployer info
    if (!deployer) {
      try {
        const dexRes = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${mint}`
        );
        if (dexRes.ok) {
          const dexData = await dexRes.json();
          const pair = dexData?.pairs?.[0];
          // Some pairs expose the deployer
          if (pair?.info?.socials?.deployer) {
            deployer = pair.info.socials.deployer;
            console.log(`[Token] ${mint.slice(0,8)}... deployer from DexScreener`);
          }
        }
      } catch {}
    }

    if (!deployer) {
      console.warn(`[Token] ${mint.slice(0,8)}... could not find deployer`);
      res.status(404).json({ success: false, error: "Could not find deployer wallet for this token. It may be too new or the mint address may be incorrect." });
      return;
    }

    console.log(`[Token] ${mint.slice(0,8)}... scoring deployer: ${deployer.slice(0,8)}...`);

    // Score the deployer
    let score = await getCachedScore(deployer);
    if (!score) {
      score = await computeRepScore(deployer);
      await setCachedScore(deployer, score);
      logScoreSnapshot(deployer, score);
      upsertLeaderboard(deployer, score);
    }

    res.json({ success: true, mint, deployer, score });

  } catch (err: any) {
    console.error("[Token] Lookup error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Verification endpoints ────────────────────────────────────

const PAYMENT_ADDRESS = process.env.PAYMENT_WALLET || '';
const REQUIRED_SOL    = 0.01;
const REQUIRED_LAMPORTS = REQUIRED_SOL * 1e9;

// GET /v1/verified/count — total verified wallets
app.get("/v1/verified/count", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.json({ count: 0 });
    return;
  }
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/verified_wallets?is_active=eq.true&select=wallet`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const data = await response.json();
    const count = Array.isArray(data) ? data.length : 0;
    res.json({ count });
  } catch {
    res.json({ count: 0 });
  }
});

// GET /v1/verified/:wallet — check if wallet is verified
app.get("/v1/verified/:wallet", async (req, res) => {
  const { wallet } = req.params;
  if (!isValidSolanaAddress(wallet)) {
    res.status(400).json({ verified: false });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.json({ verified: false });
    return;
  }
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/verified_wallets?wallet=eq.${wallet}&is_active=eq.true&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await response.json();
    if (data.length > 0) {
      res.json({ verified: true, verifiedAt: data[0].verified_at });
    } else {
      res.json({ verified: false });
    }
  } catch {
    res.json({ verified: false });
  }
});

// POST /v1/verify/payment — verify SOL payment on-chain
app.post("/v1/verify/payment", async (req, res) => {
  const { wallet, email, txSignature } = req.body;

  if (!wallet || !email || !txSignature) {
    res.status(400).json({ success: false, error: "wallet, email, and txSignature required" });
    return;
  }

  if (!isValidSolanaAddress(wallet)) {
    res.status(400).json({ success: false, error: "Invalid wallet address" });
    return;
  }

  try {
    // Verify the transaction on-chain via Helius
    const heliusRes = await fetch(
      `https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [txSignature] }),
      }
    );

    if (!heliusRes.ok) throw new Error('Failed to fetch transaction');
    const txData = await heliusRes.json();
    const tx = txData?.[0];

    if (!tx) throw new Error('Transaction not found — it may still be processing. Try again in 30 seconds.');
    if (tx.transactionError) throw new Error('Transaction failed on-chain');

    // Check sender is the wallet being verified
    if (tx.feePayer !== wallet) {
      throw new Error('Transaction was not sent from the wallet you are verifying');
    }

    // Check payment went to our address
    const paymentTransfer = (tx.nativeTransfers || []).find(
      (t: any) =>
        t.fromUserAccount === wallet &&
        t.toUserAccount === PAYMENT_ADDRESS &&
        t.amount >= REQUIRED_LAMPORTS * 0.99 // 1% tolerance
    );

    if (!paymentTransfer && PAYMENT_ADDRESS) {
      throw new Error(`Payment not found. Send exactly 0.01 SOL from ${wallet.slice(0,6)}... to the payment address.`);
    }

    // Generate nonce for message signing
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);

    // Store pending verification in Supabase
    if (SUPABASE_URL && SUPABASE_KEY) {
      await fetch(`${SUPABASE_URL}/rest/v1/verified_wallets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          wallet,
          email,
          payment_signature: txSignature,
          payment_amount_sol: REQUIRED_SOL,
          nonce,
          is_active: false, // not active until message signed
        }),
      });
    }

    console.log(`[Verify] Payment confirmed for ${wallet.slice(0,8)}...`);
    res.json({ success: true, nonce });

  } catch (err: any) {
    console.warn('[Verify] Payment check failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /v1/verify/complete — complete verification with signature
app.post("/v1/verify/complete", async (req, res) => {
  const { wallet, email, nonce, signature } = req.body;

  if (!wallet || !nonce || !signature) {
    res.status(400).json({ success: false, error: "wallet, nonce, and signature required" });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(503).json({ success: false, error: "Verification service unavailable" });
    return;
  }

  try {
    // Check nonce matches what we stored
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/verified_wallets?wallet=eq.${wallet}&nonce=eq.${nonce}&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const checkData = await checkRes.json();

    if (!checkData || checkData.length === 0) {
      throw new Error('Verification session not found. Please restart the process.');
    }

    // Activate the verification
    await fetch(
      `${SUPABASE_URL}/rest/v1/verified_wallets?wallet=eq.${wallet}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          is_active: true,
          verification_message: signature,
          verified_at: new Date().toISOString(),
        }),
      }
    );

    // Bust the score cache so verified status shows immediately
    await bustCache(wallet);

    console.log(`[Verify] ✓ Wallet verified: ${wallet.slice(0,8)}...`);
    // Send verification confirmation email
    try {
      await sendVerificationEmail(email, wallet);
    } catch (emailErr: any) {
      console.warn('[Email] Verification email failed:', emailErr.message);
    }
    res.json({ success: true, message: "Wallet verified successfully" });

  } catch (err: any) {
    console.warn('[Verify] Complete failed:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Watchlist endpoints ───────────────────────────────────────

// GET /v1/watchlist?email=xxx — get all watched wallets for email
app.get("/v1/watchlist", async (req, res) => {
  const email = req.query.email as string;
  if (!email || !email.includes('@')) {
    res.status(400).json({ error: "Valid email required" });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(503).json({ error: "Watchlist unavailable" });
    return;
  }
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/watchlist?email=eq.${encodeURIComponent(email)}&order=created_at.desc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await response.json();
    res.json({ success: true, watchlist: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /v1/watchlist — add wallet to watchlist
app.post("/v1/watchlist", async (req, res) => {
  const { email, wallet, label } = req.body;
  if (!email || !wallet || !isValidSolanaAddress(wallet)) {
    res.status(400).json({ success: false, error: "Valid email and wallet required" });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(503).json({ error: "Watchlist unavailable" });
    return;
  }
  try {
    // Add to watchlist
    const response = await fetch(`${SUPABASE_URL}/rest/v1/watchlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=ignore-duplicates',
      },
      body: JSON.stringify({ email, wallet, label: label || null }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text);
    }

    // Trigger a score fetch so we have initial data
    const cached = await getCachedScore(wallet);
    if (!cached) {
      // Score in background — don't wait
      computeRepScore(wallet).then(async (score) => {
        await setCachedScore(wallet, score);
        logScoreSnapshot(wallet, score);
        upsertLeaderboard(wallet, score);
        // Update watchlist with initial score
        await updateWatchlistScore(email, wallet, score);
      }).catch(() => {});
    } else {
      await updateWatchlistScore(email, wallet, cached);
    }

    res.json({ success: true, message: "Wallet added to watchlist" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /v1/watchlist — remove wallet from watchlist
app.delete("/v1/watchlist", async (req, res) => {
  const { email, wallet } = req.body;
  if (!email || !wallet) {
    res.status(400).json({ error: "Email and wallet required" });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(503).json({ error: "Watchlist unavailable" });
    return;
  }
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/watchlist?email=eq.${encodeURIComponent(email)}&wallet=eq.${wallet}`,
      {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
      }
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Helper — update watchlist score after scoring
async function updateWatchlistScore(email: string, wallet: string, score: any) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/watchlist?email=eq.${encodeURIComponent(email)}&wallet=eq.${wallet}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          last_score: score.score,
          last_tier: score.tier,
          last_scored_at: new Date().toISOString(),
        }),
      }
    );
  } catch {}
}

// Helper — check watchlist for score changes and update
async function checkWatchlistChanges(wallet: string, newScore: any) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    // Get all watchers for this wallet
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/watchlist?wallet=eq.${wallet}&alert_on_change=eq.true`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const watchers = await res.json();

    for (const watcher of watchers) {
      if (!watcher.last_score) {
        // First score — just update, no alert
        await updateWatchlistScore(watcher.email, wallet, newScore);
        continue;
      }

      const change = Math.abs(newScore.score - watcher.last_score);
      const minChange = watcher.min_change || 50;

      if (change >= minChange) {
        // Score changed significantly — log it (email sending requires email service)
        console.log(`[Watchlist] Alert: ${wallet.slice(0,8)}... score changed ${watcher.last_score} → ${newScore.score} for ${watcher.email}`);
        // Send email alert
        try {
          await sendScoreChangeAlert(
            watcher.email,
            wallet,
            watcher.last_score,
            newScore.score,
            newScore.tier,
            watcher.label
          );
        } catch (emailErr: any) {
          console.warn('[Email] Alert failed:', emailErr.message);
        }
        // Update score
        await updateWatchlistScore(watcher.email, wallet, newScore);
      } else {
        // Small change — just update silently
        await updateWatchlistScore(watcher.email, wallet, newScore);
      }
    }
  } catch (err: any) {
    console.warn('[Watchlist] Check failed:', err.message);
  }
}
// ── Legacy route aliases (for repscore.xyz frontend) ─────────
// Frontend calls /score/:wallet — redirect to /v1/score/:wallet

app.get("/score/:wallet", publicLimiter, async (req, res) => {
  const { wallet } = req.params;
  const forceRefresh = req.query.refresh === "true";

  if (!isValidSolanaAddress(wallet)) {
    res.status(400).json({ success: false, error: "Invalid Solana wallet address" });
    return;
  }

  try {
    let score = forceRefresh ? null : await getCachedScore(wallet);
    const fromCache = !!score;
    if (!score) {
      score = await computeRepScore(wallet);
      await setCachedScore(wallet, score);
      logScoreSnapshot(wallet, score);
      upsertLeaderboard(wallet, score);
    }
    res.json({ success: true, data: score, fromCache });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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
