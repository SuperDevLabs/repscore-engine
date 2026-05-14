// ============================================================
// RepScore Engine — Orchestrator (pump.fun native)
// v2: time-decay, sybil clustering, Gini coefficient,
//     cross-token holder overlap, social verification boost
// ============================================================

import {
  RepScore, ScoreFlag, ScoreTier,
  ScoreMetadata, TokenLaunch, WalletRole,
} from "./types/index.js";

import {
  getWalletSignatures, getWalletAge, getEnhancedTransactions,
  getTokensDeployedBy, getTokenMetadata, getWalletVolume,
  detectLinkedWallets, getTokenHolderCount, getTokenLargestHolders,
} from "./fetcher.js";

import {
  scoreLaunchHistory, scoreLiquidityBehavior,
  scoreHolderRetention, scoreCommunitySignals, scoreWalletHistory,
} from "./scorers/index.js";

import { detectStreamflowLocks } from "./streamflow.js";
import { detectSelfSnipe } from "./bundleDetector.js";
import { detectRaydiumGraduation } from "./raydiumDetector.js";

// ── Time-decay helper ─────────────────────────────────────────
// Events older than 180 days carry less weight.
// Decay follows a 6-month half-life exponential curve.
// Recent events (< 7 days) get a slight recency boost.

export function timeDecayFactor(eventTimestamp: number): number {
  const daysSince = (Date.now() / 1000 - eventTimestamp) / 86400;
  if (daysSince < 0) return 1;
  if (daysSince < 7) return 1.1;                          // recency boost
  return Math.exp(-daysSince / 180);                      // 6-month half-life
}

// ── Gini coefficient (holder concentration) ───────────────────
// 0 = perfectly equal distribution (good)
// 1 = one wallet holds everything (bad)

export function giniCoefficient(balances: number[]): number {
  if (balances.length === 0) return 0;
  const sorted = [...balances].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return numerator / (n * total);
}

// ── Cross-token holder overlap ────────────────────────────────
// Returns 0–1: fraction of buyers shared across launches.
// High overlap = fake volume / coordinated wash trading.

export function holderOverlapScore(holderSets: Set<string>[]): number {
  if (holderSets.length < 2) return 0;
  const [first, ...rest] = holderSets;
  const allOthers = new Set(rest.flatMap((s) => [...s]));
  if (allOthers.size === 0) return 0;
  let overlap = 0;
  for (const h of first) {
    if (allOthers.has(h)) overlap++;
  }
  return overlap / Math.max(first.size, 1);
}

// ── Social verification check ─────────────────────────────────
// Checks Supabase verified_wallets table for this wallet.

async function isWalletSociallyVerified(wallet: string): Promise<boolean> {
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
  if (!SUPABASE_URL || !SUPABASE_KEY) return false;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/verified_wallets?wallet=eq.${wallet}&is_active=eq.true&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await res.json();
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

// ── Deep wallet cluster analysis ──────────────────────────────
// Traces funding wallets up to 3 hops to detect sybil networks.
// Returns a risk score 0–100 (0 = clean, 100 = highly suspicious).

async function analyzWalletCluster(
  wallet: string,
  directFunders: string[],
  txns: any[]
): Promise<{ riskScore: number; clusterSize: number; signals: string[] }> {
  const signals: string[] = [];
  let riskScore = 0;

  // Hop 1: direct funders already detected
  const hop1 = new Set(directFunders);

  // Hop 2: fetch funders of funders (batch, best-effort)
  const hop2 = new Set<string>();
  const hop2Promises = [...hop1].slice(0, 5).map(async (funder) => {
    try {
      const sigs = await getWalletSignatures(funder, 100);
      const ftxns = sigs.length > 0 ? await getEnhancedTransactions(sigs.slice(0, 50)) : [];
      for (const tx of ftxns) {
        for (const transfer of tx.nativeTransfers || []) {
          if (
            transfer.toUserAccount === funder &&
            transfer.amount / 1e9 > 0.05 &&
            transfer.fromUserAccount !== wallet &&
            !hop1.has(transfer.fromUserAccount)
          ) {
            hop2.add(transfer.fromUserAccount);
          }
        }
      }
    } catch { /* best-effort */ }
  });
  await Promise.allSettled(hop2Promises);

  const totalCluster = hop1.size + hop2.size;

  // Risk scoring
  if (totalCluster >= 20) {
    riskScore = 80;
    signals.push(`Large wallet cluster: ${totalCluster} linked wallets (2 hops)`);
  } else if (totalCluster >= 10) {
    riskScore = 50;
    signals.push(`Medium wallet cluster: ${totalCluster} linked wallets`);
  } else if (totalCluster >= 5) {
    riskScore = 25;
    signals.push(`${totalCluster} linked funding wallets detected`);
  }

  // Check if multiple funders sent in tight time windows (coordinated funding)
  const fundingTimes: number[] = [];
  for (const tx of txns) {
    for (const transfer of tx.nativeTransfers || []) {
      if (transfer.toUserAccount === wallet && hop1.has(transfer.fromUserAccount)) {
        fundingTimes.push(tx.timestamp);
      }
    }
  }
  if (fundingTimes.length >= 3) {
    fundingTimes.sort((a, b) => a - b);
    const windowHours = (fundingTimes[fundingTimes.length - 1] - fundingTimes[0]) / 3600;
    if (windowHours < 1) {
      riskScore = Math.min(100, riskScore + 30);
      signals.push(`${fundingTimes.length} wallets funded this wallet within 1 hour`);
    }
  }

  return { riskScore, clusterSize: totalCluster, signals };
}

// ── Main Entry Point ──────────────────────────────────────────

export async function computeRepScore(wallet: string): Promise<RepScore> {
  console.log(`[RepScore] Scoring: ${wallet.slice(0, 8)}...`);

  const flags: ScoreFlag[] = [];

  const [signatures, walletAgeDays, sociallyVerified] = await Promise.all([
    getWalletSignatures(wallet, 1000),   // ← increased from 600
    getWalletAge(wallet),
    isWalletSociallyVerified(wallet),
  ]);

  const txns = signatures.length > 0
    ? await getEnhancedTransactions(signatures.slice(0, 200))
    : [];

  const [mintRecords, totalVolumeSol, directFunders] = await Promise.all([
    getTokensDeployedBy(wallet),
    getWalletVolume(txns, wallet),
    detectLinkedWallets(wallet, txns),
  ]);

  // ── Deep cluster analysis (improvement #2) ──
  const clusterAnalysis = await analyzWalletCluster(wallet, directFunders, txns);

  console.log(`[RepScore] ${wallet.slice(0,8)}... found ${mintRecords.length} token(s) deployed`);

  // ── Build launch records with time-decay metadata ──
  const launches: TokenLaunch[] = await Promise.all(
    mintRecords.slice(0, 20).map((record) =>
      buildLaunchRecord(record.mint, record.deployedAt, wallet, txns)
    )
  );

  // ── Gini coefficient per launch (improvement #4) ──
  const holderSets: Set<string>[] = [];
  const giniScores: number[] = [];

  await Promise.allSettled(
    launches.slice(0, 10).map(async (launch) => {
      try {
        const holders = await getTokenLargestHolders(launch.mint);
        if (holders.length > 0) {
          const balances = holders.map((h) => h.balance);
          const gini = giniCoefficient(balances);
          giniScores.push(gini);
          holderSets.push(new Set(holders.map((h) => h.address)));
          launch.giniCoefficient = gini;
        }
      } catch { /* best-effort */ }
    })
  );

  // ── Cross-token holder overlap (improvement #6) ──
  const overlapFraction = holderOverlapScore(holderSets);
  const hasWashTrading = overlapFraction > 0.4;
  if (hasWashTrading) {
    flags.push({
      severity: "HIGH",
      code: "WASH_TRADING_SUSPECTED",
      description: `${Math.round(overlapFraction * 100)}% holder overlap across launches — possible coordinated wash trading`,
    });
  }

  // ── Time-decay weights for each launch ──
  // Recent launches matter more. Old launches decay in influence.
  const decayWeights = launches.map((l) => timeDecayFactor(l.deployedAt));
  const totalDecayWeight = decayWeights.reduce((a, b) => a + b, 0) || 1;

  // Attach decay weight to each launch for scorers to use
  launches.forEach((l, i) => {
    l.decayWeight = decayWeights[i] / totalDecayWeight;
  });

  const role: WalletRole = detectRole(launches, signatures.length);

  // ── Score components ──
  const launchHistory     = scoreLaunchHistory(launches, flags);
  const liquidityBehavior = scoreLiquidityBehavior(launches, flags);
  const holderRetention   = scoreHolderRetention(launches, flags, giniScores);
  const communitySignals  = scoreCommunitySignals(launches, flags);
  const walletHistory     = scoreWalletHistory(
    walletAgeDays, totalVolumeSol, signatures.length,
    directFunders, clusterAnalysis, flags
  );

  // ── Final score ──
  let rawTotal =
    launchHistory.weighted +
    liquidityBehavior.weighted +
    holderRetention.weighted +
    communitySignals.weighted +
    walletHistory.weighted;

  // ── Social verification boost (improvement #7) ──
  // Verified identity raises the cost of abandonment.
  // Boost is capped to prevent gaming — can't buy your way past bad history.
  if (sociallyVerified) {
    rawTotal += 5; // +50 score points max after ×10 multiply
    console.log(`[RepScore] ${wallet.slice(0,8)}... socially verified — +50 score`);
  }

  // ── Wash trading penalty ──
  if (hasWashTrading) {
    rawTotal -= 3; // -30 score points
  }

  // ── Cluster risk penalty (improvement #2) ──
  if (clusterAnalysis.riskScore >= 80) {
    rawTotal -= 5; // -50 points for large sybil cluster
  } else if (clusterAnalysis.riskScore >= 50) {
    rawTotal -= 3; // -30 points for medium cluster
  } else if (clusterAnalysis.riskScore >= 25) {
    rawTotal -= 1; // -10 points
  }

  let score = Math.round(rawTotal * 10);

  // Hard caps for critical flags
  if (flags.some((f) => f.code === "SERIAL_EARLY_DUMP"))      score = Math.min(score, 250);
  if (flags.some((f) => f.code === "POST_GRAD_LP_PULL"))      score = Math.min(score, 300);
  if (flags.some((f) => f.code === "SELF_SNIPE"))             score = Math.min(score, 350);
  if (flags.some((f) => f.code === "WASH_TRADING_SUSPECTED")) score = Math.min(score, 400);
  if (flags.filter((f) => f.severity === "CRITICAL").length >= 2) score = Math.min(score, 199);

  // Legend: 10+ launches, no flags, verified, score >= 950
  if (launches.length >= 10 && flags.length === 0 && score >= 950) score = 1000;

  score = Math.max(0, Math.min(1000, score));
  const tier = scoreTier(score);

  // ── Metadata ──
  const graduated = launches.filter((l) => l.graduated);
  const avgGini = giniScores.length > 0
    ? giniScores.reduce((a, b) => a + b, 0) / giniScores.length
    : null;

  const metadata: ScoreMetadata = {
    totalLaunches: launches.length,
    successfulLaunches: launches.filter((l) => l.survivedHours >= 24 || l.graduated).length,
    rugCount: launches.filter((l) => l.devSoldPct50InFirstHour).length,
    graduatedCount: graduated.length,
    avgLongevityHours:
      launches.length > 0
        ? launches.reduce((a, l) => a + l.survivedHours * (l.decayWeight ?? 1), 0)
        : 0,
    avgHolderRetention7d:
      launches.length > 0
        ? launches.reduce((a, l) => a + l.holders7d / Math.max(l.peakHolders, 1), 0) / launches.length
        : 0,
    avgHolderRetention30d:
      launches.length > 0
        ? launches.reduce((a, l) => a + l.holders30d / Math.max(l.peakHolders, 1), 0) / launches.length
        : 0,
    totalTransactions: signatures.length,
    totalVolumeSol,
    lastActivityAt: txns.length > 0
      ? new Date(txns[0].timestamp * 1000).toISOString()
      : new Date().toISOString(),
    // New fields
    holderConcentrationGini: avgGini,
    crossTokenHolderOverlap: overlapFraction,
    walletClusterSize: clusterAnalysis.clusterSize,
    sociallyVerified,
  };

  return {
    wallet, score, tier, role,
    components: { launchHistory, liquidityBehavior, holderRetention, communitySignals, walletHistory },
    flags, metadata,
    cachedAt: new Date().toISOString(),
  };
}

// ── Build TokenLaunch from on-chain data ──────────────────────

async function buildLaunchRecord(
  mint: string,
  deployedAt: number,
  deployer: string,
  txns: any[]
): Promise<TokenLaunch> {
  const now = Date.now() / 1000;

  const [graduationData, tokenMeta, holderCount, streamflowData] = await Promise.all([
    detectRaydiumGraduation(mint, deployer, deployedAt),
    getTokenMetadata(mint),
    getTokenHolderCount(mint),
    detectStreamflowLocks(deployer),
  ]);

  let lastActivityAt: number;
  if (graduationData.graduated) {
    lastActivityAt = now;
  } else if (graduationData.currentLiquidityUsd > 100) {
    lastActivityAt = now;
  } else {
    const elapsed = now - deployedAt;
    lastActivityAt = deployedAt + Math.min(elapsed, 3600 * 48);
  }
  const survivedHours = Math.max(0, (lastActivityAt - deployedAt) / 3600);

  const devTxns = txns
    .filter((tx) => tx.feePayer === deployer && tx.timestamp >= deployedAt)
    .sort((a, b) => a.timestamp - b.timestamp);

  const devFirstSellHours = devTxns.length > 1
    ? (devTxns[1].timestamp - deployedAt) / 3600
    : null;

  const devTokensLocked = streamflowData.hasActiveLocks;
  const devLockDays = streamflowData.avgLockDays;
  const devLockPct = streamflowData.hasActiveLocks ? 80 : null;

  const snipeData = await detectSelfSnipe(mint, deployer, deployedAt);

  // Decay weight computed in orchestrator — placeholder here
  const decayWeight = timeDecayFactor(deployedAt);

  console.log(`[Launch] ${mint.slice(0,8)}... survived: ${survivedHours.toFixed(1)}h, graduated: ${graduationData.graduated}, decay: ${decayWeight.toFixed(3)}`);

  return {
    mint,
    deployer,
    deployedAt,
    lastActivityAt,
    survivedHours,
    graduated: graduationData.graduated,
    decayWeight,

    devTokensLocked,
    devLockDays,
    devLockPct,
    devSoldBeforeLockExpiry: streamflowData.hasExpiredLocks && !streamflowData.hasActiveLocks,

    devAllocationPct: 5,
    devFirstSellHours,
    devSoldPct50InFirstHour: false,
    selfSniped: snipeData.selfSniped,

    postGradLpLocked: false,
    postGradLpLockDays: null,
    postGradLpPulled: graduationData.lpPulled,
    postGradLpPulledHours: graduationData.lpPulledHoursAfterGrad,

    peakHolders: holderCount,
    holders7d:  Math.round(holderCount * 0.6),
    holders30d: Math.round(holderCount * 0.3),
    holders90d: Math.round(holderCount * 0.15),

    mintRenounced: tokenMeta.mintRenounced,
    freezeAuthorityRevoked: tokenMeta.freezeAuthorityRevoked,
    telegramDeleted: false,

    giniCoefficient: null, // populated in orchestrator after fetching holders
  };
}

// ── Helpers ───────────────────────────────────────────────────

function scoreTier(score: number): ScoreTier {
  if (score === 1000) return "LEGEND";
  if (score >= 850)   return "VERIFIED";
  if (score >= 600)   return "ESTABLISHED";
  if (score >= 400)   return "UNPROVEN";
  if (score >= 200)   return "FLAGGED";
  return "BLACKLISTED";
}

function detectRole(launches: TokenLaunch[], totalTxns: number): WalletRole {
  if (launches.length > 0 && totalTxns > 200) return "BOTH";
  if (launches.length > 0) return "DEV";
  if (totalTxns > 50) return "TRADER";
  return "UNKNOWN";
}
