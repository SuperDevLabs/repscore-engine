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
