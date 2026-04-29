// ============================================================
// RepScore Engine — Score Modules (pump.fun native)
// Each scorer returns a ComponentScore (raw 0–100 + signals)
// ============================================================

import { ComponentScore, ScoreFlag, TokenLaunch } from "../types/index.js";

// ── Longevity tier thresholds (hours) ─────────────────────────
// 99% of pump.fun tokens die within an hour.
// Surviving any meaningful time is a signal of quality.

const LONGEVITY_TIERS = [
  { hours: 168, points: 50, label: "7d+"  },  // 7 days  — elite
  { hours:  72, points: 35, label: "72h+" },  // 3 days  — exceptional
  { hours:  48, points: 28, label: "48h+" },  // 2 days  — very strong
  { hours:  24, points: 20, label: "24h+" },  // 1 day   — genuinely rare
  { hours:   8, points: 12, label: "8h+"  },  // 8 hours — top 5%
  { hours:   4, points:  8, label: "4h+"  },  // 4 hours — top 10%
  { hours:   1, points:  2, label: "1h+"  },  // 1 hour  — baseline
];

function longevityPoints(hours: number): { points: number; label: string } {
  for (const tier of LONGEVITY_TIERS) {
    if (hours >= tier.hours) return { points: tier.points, label: tier.label };
  }
  return { points: 0, label: "<1h" };
}

// ── 1. Launch History (30%) ───────────────────────────────────

export function scoreLaunchHistory(
  launches: TokenLaunch[],
  flags: ScoreFlag[]
): ComponentScore {
  const signals: string[] = [];

  if (launches.length === 0) {
    signals.push("No prior launches detected");
    return { raw: 40, weighted: 40 * 0.3, weight: 0.3, signals };
  }

  // ── Longevity scoring ──
  // Each token earns points based on how long it survived.
  // Points are cumulative — a 7d token earns all tiers below it.
  // Average across all launches = the longevity score (0–50).

  const longevityScores = launches.map((l) => {
    const { points, label } = longevityPoints(l.survivedHours);
    return { points, label, hours: l.survivedHours };
  });

  const avgLongevityPoints =
    longevityScores.reduce((a, s) => a + s.points, 0) / launches.length;

  // Scale 0–50 longevity points → 0–60 raw score contribution
  let raw = Math.round((avgLongevityPoints / 50) * 60);

  // Longevity breakdown signal
  const best = longevityScores.reduce((a, b) => (b.hours > a.hours ? b : a));
  const avgHours = longevityScores.reduce((a, s) => a + s.hours, 0) / launches.length;
  signals.push(`Avg longevity: ${formatHours(avgHours)}`);
  signals.push(`Best token: ${formatHours(best.hours)} (${best.label})`);

  // ── Graduation bonus ──
  const graduated = launches.filter((l) => l.graduated);
  if (graduated.length > 0) {
    const gradBonus = Math.min(graduated.length * 8, 24);
    raw += gradBonus;
    signals.push(`${graduated.length} token(s) graduated to Raydium`);
  }

  // ── Volume / launch count bonuses ──
  if (launches.length >= 10) { raw += 8; signals.push("10+ launch veteran"); }
  else if (launches.length >= 5) { raw += 4; signals.push(`${launches.length} launches`); }
  else { signals.push(`${launches.length} launch(es) on record`); }

  // ── Dev dump penalties ──
  // If the dev dumped within the first hour on most launches, that tanks the score
  // regardless of how long the token "survived" on paper.
  const earlyDumps = launches.filter((l) => l.devSoldPct50InFirstHour);
  if (earlyDumps.length > 0) {
    const dumpPenalty = Math.min(earlyDumps.length * 15, 40);
    raw -= dumpPenalty;
    signals.push(`Dev dumped >50% in first hour on ${earlyDumps.length} launch(es)`);
    if (earlyDumps.length >= 2) {
      flags.push({
        severity: "CRITICAL",
        code: "SERIAL_EARLY_DUMP",
        description: `Dev wallet dumped >50% of allocation within 1 hour on ${earlyDumps.length} launches`,
      });
    }
  }

  // ── Self-snipe penalty ──
  const sniped = launches.filter((l) => l.selfSniped);
  if (sniped.length > 0) {
    raw -= Math.min(sniped.length * 10, 25);
    signals.push(`Self-sniping detected on ${sniped.length} launch(es)`);
    flags.push({
      severity: "HIGH",
      code: "SELF_SNIPE",
      description: `Dev wallet sniped own launch on ${sniped.length} token(s)`,
    });
  }

  raw = clamp(raw);
  return { raw, weighted: raw * 0.3, weight: 0.3, signals };
}

// ── 2. Liquidity Behavior (25%) — pump.fun native ─────────────
// pump.fun controls LP during bonding curve — devs can't lock it.
// We score what devs CAN control: their own wallet behavior.

export function scoreLiquidityBehavior(
  launches: TokenLaunch[],
  flags: ScoreFlag[]
): ComponentScore {
  const signals: string[] = [];

  if (launches.length === 0) {
    return {
      raw: 40,
      weighted: 40 * 0.25,
      weight: 0.25,
      signals: ["No launches to evaluate"],
    };
  }

  let raw = 50;

  // ── Graduation rate ──
  // Bonding to Raydium is the strongest positive liquidity signal.
  // It means the community provided enough buy pressure to graduate.
  const graduated = launches.filter((l) => l.graduated);
  const gradRate = graduated.length / launches.length;
  if (gradRate >= 0.5) {
    raw += 25;
    signals.push(`${pct(gradRate)} graduation rate to Raydium`);
  } else if (gradRate > 0) {
    raw += Math.round(gradRate * 25);
    signals.push(`${graduated.length}/${launches.length} tokens graduated to Raydium`);
  } else {
    signals.push("No tokens graduated to Raydium");
  }

  // ── Post-graduation LP pulls (Raydium) ──
  // After graduation, the dev CAN pull LP — this is the red flag.
  const postGradPulls = launches.filter((l) => l.graduated && l.postGradLpPulled);
  if (postGradPulls.length > 0) {
    const penalty = Math.min(postGradPulls.length * 20, 50);
    raw -= penalty;
    signals.push(`Post-graduation LP pulled on ${postGradPulls.length} launch(es)`);

    const quickPulls = postGradPulls.filter(
      (l) => l.postGradLpPulledHours !== null && l.postGradLpPulledHours < 48
    );
    if (quickPulls.length > 0) {
      raw -= quickPulls.length * 10;
      signals.push(`${quickPulls.length} LP pull(s) within 48h of graduation`);
      flags.push({
        severity: "CRITICAL",
        code: "POST_GRAD_LP_PULL",
        description: `Pulled Raydium LP within 48h of graduation on ${quickPulls.length} token(s)`,
      });
    } else {
      flags.push({
        severity: "HIGH",
        code: "RAYDIUM_LP_PULL",
        description: `Pulled Raydium liquidity on ${postGradPulls.length} graduated token(s)`,
      });
    }
  }

  // ── Dev allocation at launch ──
  // High dev allocation = higher dump risk = negative signal.
  const avgDevAlloc =
    launches.reduce((a, l) => a + l.devAllocationPct, 0) / launches.length;
  if (avgDevAlloc <= 3) {
    raw += 15;
    signals.push(`Low dev allocation: avg ${avgDevAlloc.toFixed(1)}% at launch`);
  } else if (avgDevAlloc <= 8) {
    raw += 7;
    signals.push(`Moderate dev allocation: avg ${avgDevAlloc.toFixed(1)}%`);
  } else if (avgDevAlloc > 15) {
    raw -= 20;
    signals.push(`High dev allocation: avg ${avgDevAlloc.toFixed(1)}% at launch`);
    flags.push({
      severity: "HIGH",
      code: "HIGH_DEV_ALLOC",
      description: `Dev holds avg ${avgDevAlloc.toFixed(1)}% of supply at launch`,
    });
  } else {
    signals.push(`Dev allocation: avg ${avgDevAlloc.toFixed(1)}%`);
  }

  // ── Dev sell timing ──
  // How long before the dev starts selling? Longer = more trustworthy.
  const sellTimes = launches
    .filter((l) => l.devFirstSellHours !== null)
    .map((l) => l.devFirstSellHours as number);

  if (sellTimes.length > 0) {
    const avgSellHours = sellTimes.reduce((a, h) => a + h, 0) / sellTimes.length;
    if (avgSellHours >= 48) {
      raw += 15;
      signals.push(`Dev held avg ${formatHours(avgSellHours)} before first sell`);
    } else if (avgSellHours >= 8) {
      raw += 8;
      signals.push(`Dev held avg ${formatHours(avgSellHours)} before first sell`);
    } else if (avgSellHours < 1) {
      raw -= 15;
      signals.push(`Dev sold within 1h on most launches`);
      flags.push({
        severity: "HIGH",
        code: "FAST_DEV_SELL",
        description: `Dev wallet sold within 1 hour of launch on average`,
      });
    } else {
      signals.push(`Dev first sell: avg ${formatHours(avgSellHours)} after launch`);
    }
  }

  raw = clamp(raw);
  return { raw, weighted: raw * 0.25, weight: 0.25, signals };
}

// ── 3. Holder Retention (20%) ─────────────────────────────────

export function scoreHolderRetention(
  launches: TokenLaunch[],
  flags: ScoreFlag[]
): ComponentScore {
  const signals: string[] = [];

  if (launches.length === 0) {
    return {
      raw: 40,
      weighted: 40 * 0.2,
      weight: 0.2,
      signals: ["No launches to evaluate"],
    };
  }

  let raw = 50;

  // Only score retention on tokens that survived long enough to measure
  const measurable7d  = launches.filter((l) => l.survivedHours >= 168 && l.peakHolders > 0);
  const measurable30d = launches.filter((l) => l.survivedHours >= 720 && l.peakHolders > 0);

  if (measurable7d.length > 0) {
    const retention7d =
      measurable7d.reduce((a, l) => a + l.holders7d / Math.max(l.peakHolders, 1), 0) /
      measurable7d.length;

    if (retention7d >= 0.5)      { raw += 20; signals.push(`Strong 7d retention: ${pct(retention7d)}`); }
    else if (retention7d >= 0.25){ raw += 10; signals.push(`Moderate 7d retention: ${pct(retention7d)}`); }
    else if (retention7d < 0.1)  {
      raw -= 15;
      signals.push(`Poor 7d retention: ${pct(retention7d)}`);
      flags.push({ severity: "HIGH", code: "LOW_7D_RETENTION", description: "Avg 7-day holder retention below 10%" });
    } else {
      signals.push(`7d retention: ${pct(retention7d)}`);
    }
  } else {
    signals.push("Insufficient data for 7d retention (need tokens surviving 7d+)");
  }

  if (measurable30d.length > 0) {
    const retention30d =
      measurable30d.reduce((a, l) => a + l.holders30d / Math.max(l.peakHolders, 1), 0) /
      measurable30d.length;

    if (retention30d >= 0.3)      { raw += 15; signals.push(`Strong 30d retention: ${pct(retention30d)}`); }
    else if (retention30d >= 0.1) { raw += 5;  signals.push(`Moderate 30d retention: ${pct(retention30d)}`); }
    else if (retention30d < 0.05) {
      raw -= 10;
      signals.push(`Poor 30d retention: ${pct(retention30d)}`);
      flags.push({ severity: "MEDIUM", code: "LOW_30D_RETENTION", description: "Avg 30-day holder retention below 5%" });
    }
  }

  // Holder cliff — sudden mass exit
  const cliffLaunches = launches.filter(
    (l) => l.peakHolders > 50 && l.holders7d / Math.max(l.peakHolders, 1) < 0.05
  );
  if (cliffLaunches.length > 0) {
    raw -= 15;
    signals.push(`Holder cliff on ${cliffLaunches.length} launch(es)`);
    flags.push({ severity: "HIGH", code: "HOLDER_CLIFF", description: "95%+ holder exit detected" });
  }

  // Peak holder count — community signal
  const avgPeak = launches.reduce((a, l) => a + l.peakHolders, 0) / launches.length;
  if (avgPeak >= 500)      { raw += 10; signals.push(`Peak community: avg ${Math.round(avgPeak).toLocaleString()} holders`); }
  else if (avgPeak >= 100) { raw += 5;  signals.push(`Peak community: avg ${Math.round(avgPeak)} holders`); }
  else                     { signals.push(`Peak community: avg ${Math.round(avgPeak)} holders`); }

  raw = clamp(raw);
  return { raw, weighted: raw * 0.2, weight: 0.2, signals };
}

// ── 4. Community Signals (15%) ────────────────────────────────

export function scoreCommunitySignals(
  launches: TokenLaunch[],
  flags: ScoreFlag[]
): ComponentScore {
  const signals: string[] = [];
  let raw = 50;

  if (launches.length === 0) {
    return {
      raw: 40,
      weighted: 40 * 0.15,
      weight: 0.15,
      signals: ["No launches to evaluate"],
    };
  }

  // Telegram deletion
  const deletedTelegrams = launches.filter((l) => l.telegramDeleted);
  if (deletedTelegrams.length === 0) {
    raw += 20;
    signals.push("Telegram maintained on all launches");
  } else {
    const deleteRate = deletedTelegrams.length / launches.length;
    raw -= Math.round(deleteRate * 35);
    signals.push(`Telegram deleted on ${deletedTelegrams.length}/${launches.length} launches`);
    if (deleteRate >= 0.5) {
      flags.push({
        severity: "HIGH",
        code: "TELEGRAM_DELETED",
        description: "Community channel deleted after >50% of launches",
      });
    }
  }

  // Mint authority — pump.fun auto-renounces on graduation,
  // but for tokens that didn't graduate this still matters
  const renouncedMints = launches.filter((l) => l.mintRenounced);
  if (renouncedMints.length === launches.length) {
    raw += 15;
    signals.push("Mint authority renounced on all launches");
  } else if (renouncedMints.length > 0) {
    raw += 7;
    signals.push(`Mint renounced on ${renouncedMints.length}/${launches.length} launches`);
  } else if (launches.filter((l) => !l.graduated).length > 0) {
    // Only penalize if non-graduated tokens exist without renouncement
    raw -= 10;
    signals.push("Mint authority not renounced on non-graduated tokens");
    flags.push({
      severity: "MEDIUM",
      code: "MINT_AUTHORITY_ACTIVE",
      description: "Mint authority active on non-graduated tokens",
    });
  }

  // Freeze authority
  const frozenRevoked = launches.filter((l) => l.freezeAuthorityRevoked);
  if (frozenRevoked.length === launches.length) {
    raw += 10;
    signals.push("Freeze authority revoked on all launches");
  } else if (frozenRevoked.length < launches.length) {
    raw -= 8;
    signals.push("Freeze authority not fully revoked");
    flags.push({
      severity: "MEDIUM",
      code: "FREEZE_AUTHORITY_ACTIVE",
      description: "Freeze authority active — dev can freeze token accounts",
    });
  }

  raw = clamp(raw);
  return { raw, weighted: raw * 0.15, weight: 0.15, signals };
}

// ── 5. Wallet History (10%) ───────────────────────────────────

export function scoreWalletHistory(
  walletAgeDays: number,
  totalVolumeSol: number,
  totalTxns: number,
  linkedWallets: string[],
  flags: ScoreFlag[]
): ComponentScore {
  const signals: string[] = [];
  let raw = 50;

  // Wallet age
  if (walletAgeDays >= 365)     { raw += 20; signals.push(`Wallet age: ${Math.round(walletAgeDays / 30)}mo`); }
  else if (walletAgeDays >= 90) { raw += 10; signals.push(`Wallet age: ${walletAgeDays}d`); }
  else if (walletAgeDays < 30)  {
    raw -= 20;
    signals.push(`New wallet: ${walletAgeDays}d old`);
    flags.push({ severity: "MEDIUM", code: "NEW_WALLET", description: `Wallet is only ${walletAgeDays} days old` });
  } else {
    signals.push(`Wallet age: ${walletAgeDays}d`);
  }

  // Tx count — consistency signal
  if (totalTxns >= 1000)      { raw += 10; signals.push(`${totalTxns.toLocaleString()} lifetime txns`); }
  else if (totalTxns >= 100)  { raw += 5;  signals.push(`${totalTxns.toLocaleString()} lifetime txns`); }
  else if (totalTxns < 10)    { raw -= 10; signals.push("Very low transaction history"); }

  // Volume
  if (totalVolumeSol >= 1000) { raw += 10; signals.push(`${totalVolumeSol.toLocaleString()} SOL lifetime volume`); }
  else if (totalVolumeSol >= 100) { raw += 5; }

  // Linked wallet cluster — sybil / multi-wallet signal
  if (linkedWallets.length >= 5) {
    raw -= 15;
    signals.push(`${linkedWallets.length} linked funding wallets`);
    flags.push({
      severity: "MEDIUM",
      code: "MULTI_WALLET_CLUSTER",
      description: `Wallet funded by ${linkedWallets.length} wallets — possible multi-wallet operation`,
    });
  }

  raw = clamp(raw);
  return { raw, weighted: raw * 0.1, weight: 0.1, signals };
}

// ── Helpers ───────────────────────────────────────────────────

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function formatHours(hours: number): string {
  if (hours < 1)    return `${Math.round(hours * 60)}m`;
  if (hours < 24)   return `${Math.round(hours)}h`;
  if (hours < 168)  return `${(hours / 24).toFixed(1)}d`;
  return `${(hours / 168).toFixed(1)}w`;
}

// ============================================================
// RepScore — Register Helius Webhook
// Run once: node --import tsx/esm src/setup/register-webhook.ts
// ============================================================
//
// This registers a Helius webhook that fires on every new
// pump.fun token creation — so we auto-score every deployer.
//
// Run this ONCE after deploying to Render.
// ============================================================

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_URL    = process.env.WEBHOOK_URL || "https://api.repscore.xyz/webhooks/helius";
const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || "";

// pump.fun program ID on Solana mainnet
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

if (!HELIUS_API_KEY) {
  console.error("✗ HELIUS_API_KEY not set");
  process.exit(1);
}

console.log("RepScore — Helius Webhook Registration");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`Webhook URL:    ${WEBHOOK_URL}`);
console.log(`Program:        ${PUMP_FUN_PROGRAM} (pump.fun)`);
console.log(`Transaction:    CREATE (new token launches only)`);
console.log("");

// ── Step 1: List existing webhooks ───────────────────────────

console.log("Checking existing webhooks...");

const listRes = await fetch(
  `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`
);

if (!listRes.ok) {
  console.error("✗ Failed to list webhooks:", await listRes.text());
  process.exit(1);
}

const existing = await listRes.json();
console.log(`Found ${existing.length} existing webhook(s)`);

// Check if already registered
const alreadyExists = existing.find(
  (w: any) =>
    w.webhookURL === WEBHOOK_URL &&
    w.accountAddresses?.includes(PUMP_FUN_PROGRAM)
);

if (alreadyExists) {
  console.log(`\n✓ Webhook already registered (ID: ${alreadyExists.webhookID})`);
  console.log("  Nothing to do — pump.fun launches are already being tracked.");
  process.exit(0);
}

// ── Step 2: Register the webhook ─────────────────────────────

console.log("\nRegistering new webhook...");

const body: Record<string, any> = {
  webhookURL: WEBHOOK_URL,
  webhookType: "enhanced",
  accountAddresses: [PUMP_FUN_PROGRAM],
  transactionTypes: ["CREATE"],
};

// Add secret if configured
if (WEBHOOK_SECRET) {
  body.authHeader = WEBHOOK_SECRET;
}

const createRes = await fetch(
  `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
);

const result = await createRes.json();

if (!createRes.ok) {
  console.error("✗ Failed to register webhook:");
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

// ── Step 3: Confirm ───────────────────────────────────────────

console.log("\n✓ Webhook registered successfully!");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  Webhook ID:  ${result.webhookID}`);
console.log(`  URL:         ${result.webhookURL}`);
console.log(`  Type:        ${result.webhookType}`);
console.log(`  Program:     ${PUMP_FUN_PROGRAM}`);
console.log("");
console.log("Every new pump.fun token launch will now auto-score the deployer.");
console.log("Monitor activity at: https://api.repscore.xyz/webhooks/stats");
console.log("");
console.log("Save this webhook ID in case you need to delete it later:");
console.log(`  DELETE: https://api.helius.xyz/v0/webhooks/${result.webhookID}?api-key=YOUR_KEY`);

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

// ── Webhook routes (Helius pump.fun indexer) ──────────────────
// Helius POSTs to /webhooks/helius on every new pump.fun launch
// Stats available at /webhooks/stats

app.use("/webhooks", webhookRouter);

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

// ============================================================
// RepScore Engine — Helius Webhook Handler
// Auto-indexes every new pump.fun token launch
// ============================================================
//
// Setup (one time):
//   POST https://api.helius.xyz/v0/webhooks?api-key=YOUR_KEY
//   {
//     "webhookURL": "https://api.repscore.xyz/webhooks/helius",
//     "webhookType": "enhanced",
//     "accountAddresses": ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"],
//     "transactionTypes": ["CREATE"]
//   }
//
// 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P = pump.fun program ID
// ============================================================

import { Router, Request, Response } from "express";
import { computeRepScore } from "../engine.ts";
import { getCachedScore, setCachedScore } from "../cache.ts";

export const webhookRouter = Router();

// ── Pump.fun program ID ───────────────────────────────────────
const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// ── In-memory queue to prevent duplicate scoring ──────────────
const scoringQueue = new Set<string>();
const recentlyScored = new Map<string, number>(); // wallet → timestamp
const RESCORE_COOLDOWN_MS = 1000 * 60 * 60; // 1 hour min between rescores

// ── Stats for monitoring ──────────────────────────────────────
const stats = {
  webhooksReceived: 0,
  launchesDetected: 0,
  walletsScoredTotal: 0,
  walletsQueuedNow: 0,
  errors: 0,
  lastWebhookAt: null as string | null,
  lastScoredWallet: null as string | null,
};

// ── Main webhook endpoint ─────────────────────────────────────
// Helius POSTs here for every new pump.fun CREATE transaction

webhookRouter.post("/helius", async (req: Request, res: Response) => {
  stats.webhooksReceived++;
  stats.lastWebhookAt = new Date().toISOString();

  // Verify webhook secret if set
  const secret = req.headers["helius-webhook-secret"];
  if (process.env.HELIUS_WEBHOOK_SECRET && secret !== process.env.HELIUS_WEBHOOK_SECRET) {
    console.warn("[Webhook] Invalid secret — rejecting");
    res.status(401).json({ error: "Invalid webhook secret" });
    return;
  }

  // Acknowledge immediately — Helius expects fast response
  res.status(200).json({ received: true });

  // Process async so we don't block the webhook response
  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const event of events) {
    try {
      await processLaunchEvent(event);
    } catch (err: any) {
      stats.errors++;
      console.error("[Webhook] Event processing error:", err.message);
    }
  }
});

// ── Process a single launch event ────────────────────────────

async function processLaunchEvent(event: any): Promise<void> {
  // Helius enhanced transaction format
  const type = event.type;
  const accounts: string[] = event.accountData?.map((a: any) => a.account) || [];
  const feePayer: string = event.feePayer || "";
  const timestamp: number = event.timestamp || Date.now() / 1000;

  // Confirm this is a pump.fun token creation
  const isPumpFunCreate =
    type === "CREATE" ||
    accounts.includes(PUMP_FUN_PROGRAM) ||
    (event.instructions || []).some((ix: any) => ix.programId === PUMP_FUN_PROGRAM);

  if (!isPumpFunCreate) return;

  // Extract the deployer wallet
  const deployer = extractDeployer(event);
  if (!deployer) {
    console.log("[Webhook] Could not extract deployer from event");
    return;
  }

  // Extract the token mint
  const mint = extractMint(event);

  stats.launchesDetected++;
  console.log(`[Webhook] New pump.fun launch detected`);
  console.log(`  Deployer: ${deployer.slice(0, 8)}...`);
  console.log(`  Mint:     ${mint ? mint.slice(0, 8) + "..." : "unknown"}`);
  console.log(`  Time:     ${new Date(timestamp * 1000).toISOString()}`);

  // Queue deployer for scoring
  await queueWalletScore(deployer, "pump_fun_launch");
}

// ── Score queue with rate limiting ───────────────────────────
// Prevents hammering Helius if the same dev launches multiple tokens

async function queueWalletScore(
  wallet: string,
  reason: string
): Promise<void> {
  // Skip if already in queue
  if (scoringQueue.has(wallet)) {
    console.log(`[Queue] ${wallet.slice(0, 8)}... already queued, skipping`);
    return;
  }

  // Skip if scored recently
  const lastScored = recentlyScored.get(wallet);
  if (lastScored && Date.now() - lastScored < RESCORE_COOLDOWN_MS) {
    console.log(`[Queue] ${wallet.slice(0, 8)}... scored recently, skipping`);
    return;
  }

  // Check if already cached with fresh data
  const cached = await getCachedScore(wallet);
  if (cached) {
    console.log(`[Queue] ${wallet.slice(0, 8)}... has fresh cached score (${cached.score}), skipping`);
    return;
  }

  scoringQueue.add(wallet);
  stats.walletsQueuedNow = scoringQueue.size;
  console.log(`[Queue] Added ${wallet.slice(0, 8)}... (reason: ${reason}) — queue size: ${scoringQueue.size}`);

  // Score with a small delay to avoid rate limiting
  // Stagger multiple launches from same block
  const delay = Math.random() * 3000 + 1000; // 1–4 seconds random delay
  setTimeout(() => scoreWallet(wallet), delay);
}

async function scoreWallet(wallet: string): Promise<void> {
  try {
    console.log(`[Scorer] Scoring ${wallet.slice(0, 8)}...`);
    const score = await computeRepScore(wallet);
    await setCachedScore(wallet, score);

    stats.walletsScoredTotal++;
    stats.lastScoredWallet = wallet;
    recentlyScored.set(wallet, Date.now());

    console.log(`[Scorer] ✓ ${wallet.slice(0, 8)}... → ${score.score}/1000 (${score.tier})`);

    // Clean up old entries from recentlyScored map (prevent memory leak)
    if (recentlyScored.size > 5000) {
      const cutoff = Date.now() - RESCORE_COOLDOWN_MS;
      for (const [w, ts] of recentlyScored.entries()) {
        if (ts < cutoff) recentlyScored.delete(w);
      }
    }
  } catch (err: any) {
    stats.errors++;
    console.error(`[Scorer] Failed to score ${wallet.slice(0, 8)}...:`, err.message);
  } finally {
    scoringQueue.delete(wallet);
    stats.walletsQueuedNow = scoringQueue.size;
  }
}

// ── Extract deployer from Helius event ────────────────────────

function extractDeployer(event: any): string | null {
  // Primary: feePayer is almost always the deployer on pump.fun
  if (event.feePayer && isValidWallet(event.feePayer)) {
    return event.feePayer;
  }

  // Fallback: first signer in the transaction
  const signers = event.accountData
    ?.filter((a: any) => a.nativeBalanceChange < 0) // paid SOL = signer
    ?.map((a: any) => a.account)
    ?.filter((a: string) => isValidWallet(a) && a !== PUMP_FUN_PROGRAM);

  if (signers?.length > 0) return signers[0];

  return null;
}

function extractMint(event: any): string | null {
  // Find the newly created token mint from token balance changes
  for (const acct of event.accountData || []) {
    for (const change of acct.tokenBalanceChanges || []) {
      if (change.mint && isValidWallet(change.mint)) {
        return change.mint;
      }
    }
  }
  return null;
}

function isValidWallet(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// ── Stats endpoint ─────────────────────────────────────────────

webhookRouter.get("/stats", (_req: Request, res: Response) => {
  res.json({
    ...stats,
    queuedWallets: [...scoringQueue].map((w) => w.slice(0, 8) + "..."),
    recentlyScoredCount: recentlyScored.size,
    uptime: process.uptime(),
  });
});

// ── Manual trigger (for testing) ──────────────────────────────

webhookRouter.post("/trigger", async (req: Request, res: Response) => {
  const { wallet } = req.body;
  if (!wallet || !isValidWallet(wallet)) {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  console.log(`[Webhook] Manual trigger for ${wallet.slice(0, 8)}...`);
  await queueWalletScore(wallet, "manual_trigger");
  res.json({ queued: true, wallet, queueSize: scoringQueue.size });
});

// ============================================================
// RepScore Engine — Core Types
// repscore.xyz
// ============================================================

export type ScoreTier =
  | "LEGEND"
  | "VERIFIED"
  | "ESTABLISHED"
  | "UNPROVEN"
  | "FLAGGED"
  | "BLACKLISTED";

export type WalletRole = "DEV" | "TRADER" | "BOTH" | "UNKNOWN";

export interface RepScore {
  wallet: string;
  score: number;          // 0–1000
  tier: ScoreTier;
  role: WalletRole;
  components: ScoreComponents;
  flags: ScoreFlag[];
  metadata: ScoreMetadata;
  cachedAt: string;
}

export interface ScoreComponents {
  launchHistory:     ComponentScore; // 30%
  liquidityBehavior: ComponentScore; // 25%
  holderRetention:   ComponentScore; // 20%
  communitySignals:  ComponentScore; // 15%
  walletHistory:     ComponentScore; // 10%
}

export interface ComponentScore {
  raw: number;
  weighted: number;
  weight: number;
  signals: string[];
}

export interface ScoreFlag {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  code: string;
  description: string;
  detectedAt?: string;
}

export interface ScoreMetadata {
  totalLaunches: number;
  successfulLaunches: number;
  rugCount: number;
  graduatedCount: number;       // bonded to Raydium
  avgLongevityHours: number;    // pump.fun reality — hours not days
  avgHolderRetention7d: number;
  avgHolderRetention30d: number;
  walletAgeDays: number;
  totalVolumeSol: number;
  lastActivityAt: string;
}

// ── Raw on-chain data structures ──────────────────────────────

export interface TokenLaunch {
  mint: string;
  deployer: string;
  deployedAt: number;             // unix timestamp

  // Longevity — pump.fun tiered milestones
  lastActivityAt: number;         // unix timestamp of last meaningful tx
  survivedHours: number;          // how long the token stayed alive
  graduated: boolean;             // bonded to Raydium

  // Dev wallet behavior
  devAllocationPct: number;       // % of supply held at launch
  devFirstSellHours: number | null; // hours after launch before first dev sell
  devSoldPct50InFirstHour: boolean; // dumped >50% in first hour
  selfSniped: boolean;            // dev wallet bought with bot pre-launch

  // Post-graduation LP (Raydium only — pump.fun LP is protocol-controlled)
  postGradLpPulled: boolean;
  postGradLpPulledHours: number | null; // hours after graduation

  // Holders
  peakHolders: number;
  holders7d: number;
  holders30d: number;
  holders90d: number;

  // On-chain hygiene
  mintRenounced: boolean;
  freezeAuthorityRevoked: boolean;
  telegramDeleted: boolean;
}

export interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  fee: number;
  feePayer: string;
  tokenTransfers: TokenTransfer[];
  nativeTransfers: NativeTransfer[];
  accountData: AccountData[];
  events?: Record<string, any>;
}

export interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

export interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

export interface AccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: TokenBalanceChange[];
}

export interface TokenBalanceChange {
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
  userAccount: string;
}

// ── API types ─────────────────────────────────────────────────

export interface ScoreRequest {
  wallet: string;
  forceRefresh?: boolean;
}

export interface ScoreResponse {
  success: boolean;
  data?: RepScore;
  error?: string;
  fromCache?: boolean;
}

export interface BatchScoreRequest {
  wallets: string[];
  forceRefresh?: boolean;
}

export interface BatchScoreResponse {
  success: boolean;
  results: Record<string, ScoreResponse>;
  errors: Record<string, string>;
}

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

// ============================================================
// RepScore Engine — Helius Data Fetcher
// ============================================================

import { HeliusTransaction, TokenLaunch } from "../types/index.js";

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

// ── RPC Calls ─────────────────────────────────────────────────

async function rpcCall(method: string, params: any[]): Promise<any> {
  const res = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

// ── Wallet Data ───────────────────────────────────────────────

export async function getWalletSignatures(
  wallet: string,
  limit = 500
): Promise<string[]> {
  const result = await rpcCall("getSignaturesForAddress", [
    wallet,
    { limit, commitment: "finalized" },
  ]);
  return (result || []).map((s: any) => s.signature);
}

export async function getWalletAge(wallet: string): Promise<number> {
  // Returns age in days based on first transaction
  const result = await rpcCall("getSignaturesForAddress", [
    wallet,
    { limit: 1000, commitment: "finalized" },
  ]);
  if (!result || result.length === 0) return 0;
  // Last item = oldest signature
  const oldest = result[result.length - 1];
  const ageDays = (Date.now() / 1000 - oldest.blockTime) / 86400;
  return Math.floor(ageDays);
}

export async function getSolBalance(wallet: string): Promise<number> {
  const result = await rpcCall("getBalance", [wallet]);
  return (result?.value ?? 0) / 1e9;
}

// ── Transaction Parsing ───────────────────────────────────────

export async function getEnhancedTransactions(
  signatures: string[]
): Promise<HeliusTransaction[]> {
  const CHUNK = 100;
  const results: HeliusTransaction[] = [];

  for (let i = 0; i < signatures.length; i += CHUNK) {
    const chunk = signatures.slice(i, i + CHUNK);
    const res = await fetch(
      `${HELIUS_API}/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: chunk }),
      }
    );
    if (!res.ok) throw new Error(`Helius transactions API failed: ${res.status}`);
    const data = await res.json();
    results.push(...data);

    // Respect rate limits — 100ms between chunks
    if (i + CHUNK < signatures.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return results;
}

// ── Token / Mint Data ─────────────────────────────────────────

export async function getTokensDeployedBy(wallet: string): Promise<string[]> {
  // Find all mints where the wallet was the deployer
  // Helius parses TOKEN_MINT events with type detection
  const sigs = await getWalletSignatures(wallet, 500);
  if (sigs.length === 0) return [];

  const txns = await getEnhancedTransactions(sigs.slice(0, 200));
  const mints: string[] = [];

  for (const tx of txns) {
    if (tx.type === "TOKEN_MINT" && tx.feePayer === wallet) {
      // Extract newly created mint from account changes
      for (const acct of tx.accountData || []) {
        if (
          acct.tokenBalanceChanges?.length > 0 &&
          acct.tokenBalanceChanges[0].userAccount === wallet
        ) {
          mints.push(acct.tokenBalanceChanges[0].mint);
        }
      }
    }
  }

  return [...new Set(mints)]; // deduplicate
}

export async function getTokenHolderCount(mint: string): Promise<number> {
  const result = await rpcCall("getTokenLargestAccounts", [mint]);
  return result?.value?.length ?? 0;
}

export async function getTokenMetadata(mint: string): Promise<{
  mintRenounced: boolean;
  freezeAuthorityRevoked: boolean;
  supply: number;
}> {
  const result = await rpcCall("getAccountInfo", [
    mint,
    { encoding: "jsonParsed" },
  ]);

  const info = result?.value?.data?.parsed?.info;
  if (!info) {
    return { mintRenounced: false, freezeAuthorityRevoked: false, supply: 0 };
  }

  return {
    mintRenounced: info.mintAuthority === null,
    freezeAuthorityRevoked: info.freezeAuthority === null,
    supply: parseInt(info.supply || "0"),
  };
}

// ── DexScreener LP Data ───────────────────────────────────────

export async function getLpData(mint: string): Promise<{
  initialLpSol: number;
  lpLockDays: number | null;
  lpPulledAt: number | null;
  stillActive: boolean;
}> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (!res.ok) return defaultLpData();
    const data = await res.json();
    const pair = data?.pairs?.[0];
    if (!pair) return defaultLpData();

    const liquidityUsd = pair.liquidity?.usd ?? 0;
    const solPrice = 150; // approximate — replace with live feed in production
    const initialLpSol = liquidityUsd / solPrice;
    const stillActive = liquidityUsd > 500; // $500 min liquidity threshold

    return {
      initialLpSol,
      lpLockDays: null,    // Requires dedicated LP lock indexer (e.g. Streamflow)
      lpPulledAt: null,    // Inferred from liquidity cliff detection below
      stillActive,
    };
  } catch {
    return defaultLpData();
  }
}

function defaultLpData() {
  return { initialLpSol: 0, lpLockDays: null, lpPulledAt: null, stillActive: false };
}

// ── Rug Detection ─────────────────────────────────────────────

export async function detectLiquidityPull(
  mint: string,
  deployedAt: number
): Promise<{ wasRugged: boolean; ruggedAt: number | null }> {
  // Heuristic: if token had liquidity but now has <$200, and it was
  // within 72h of launch — flag as rug
  const lp = await getLpData(mint);
  const ageHours = (Date.now() / 1000 - deployedAt) / 3600;

  if (!lp.stillActive && ageHours < 72) {
    return { wasRugged: true, ruggedAt: deployedAt + ageHours * 3600 };
  }

  return { wasRugged: false, ruggedAt: null };
}

// ── Volume & Activity ─────────────────────────────────────────

export async function getWalletVolume(
  txns: HeliusTransaction[],
  wallet: string
): Promise<number> {
  let totalSol = 0;
  for (const tx of txns) {
    for (const transfer of tx.nativeTransfers || []) {
      if (
        transfer.fromUserAccount === wallet ||
        transfer.toUserAccount === wallet
      ) {
        totalSol += transfer.amount / 1e9;
      }
    }
  }
  return totalSol;
}

// ── Linked Wallet Detection ───────────────────────────────────

export async function detectLinkedWallets(
  wallet: string,
  txns: HeliusTransaction[]
): Promise<string[]> {
  // Find wallets that funded this wallet within 24h of its first tx
  const fundingWallets = new Set<string>();

  for (const tx of txns) {
    for (const transfer of tx.nativeTransfers || []) {
      if (
        transfer.toUserAccount === wallet &&
        transfer.amount / 1e9 > 0.1 // meaningful funding
      ) {
        if (transfer.fromUserAccount !== wallet) {
          fundingWallets.add(transfer.fromUserAccount);
        }
      }
    }
  }

  return [...fundingWallets].slice(0, 10); // top 10 funding sources
}
