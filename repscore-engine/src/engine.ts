// ============================================================
// RepScore Engine — Orchestrator (pump.fun native)
// ============================================================

import {
  RepScore, ScoreFlag, ScoreTier,
  ScoreMetadata, TokenLaunch, WalletRole,
} from "./types/index.js";

import {
  getWalletSignatures, getWalletAge, getEnhancedTransactions,
  getTokensDeployedBy, getTokenMetadata, getWalletVolume,
  detectLinkedWallets, getTokenHolderCount,
} from "./fetcher.js";

import {
  scoreLaunchHistory, scoreLiquidityBehavior,
  scoreHolderRetention, scoreCommunitySignals, scoreWalletHistory,
} from "./scorers/index.js";

import { detectStreamflowLocks } from "./streamflow.js";
import { detectSelfSnipe } from "./bundleDetector.js";
import { detectRaydiumGraduation } from "./raydiumDetector.js";

// ── Main Entry Point ──────────────────────────────────────────

export async function computeRepScore(wallet: string): Promise<RepScore> {
  console.log(`[RepScore] Scoring: ${wallet.slice(0, 8)}...`);

  const flags: ScoreFlag[] = [];

  const [signatures, walletAgeDays] = await Promise.all([
    getWalletSignatures(wallet, 300),
    getWalletAge(wallet),
  ]);

  const txns = signatures.length > 0
    ? await getEnhancedTransactions(signatures.slice(0, 150))
    : [];

  const [mintRecords, totalVolumeSol, linkedWallets] = await Promise.all([
    getTokensDeployedBy(wallet),
    getWalletVolume(txns, wallet),
    detectLinkedWallets(wallet, txns),
  ]);

  console.log(`[RepScore] ${wallet.slice(0,8)}... found ${mintRecords.length} token(s) deployed`);

  const launches: TokenLaunch[] = await Promise.all(
    mintRecords.slice(0, 20).map((record) =>
      buildLaunchRecord(record.mint, record.deployedAt, wallet, txns)
    )
  );

  const role: WalletRole = detectRole(launches, signatures.length);

  // ── Score components ──
  const launchHistory     = scoreLaunchHistory(launches, flags);
  const liquidityBehavior = scoreLiquidityBehavior(launches, flags);
  const holderRetention   = scoreHolderRetention(launches, flags);
  const communitySignals  = scoreCommunitySignals(launches, flags);
  const walletHistory     = scoreWalletHistory(
    walletAgeDays, totalVolumeSol, signatures.length, linkedWallets, flags
  );

  // ── Final score ──
  const rawTotal =
    launchHistory.weighted +
    liquidityBehavior.weighted +
    holderRetention.weighted +
    communitySignals.weighted +
    walletHistory.weighted;

  let score = Math.round(rawTotal * 10);

  // Hard caps for critical flags
  if (flags.some((f) => f.code === "SERIAL_EARLY_DUMP"))  score = Math.min(score, 250);
  if (flags.some((f) => f.code === "POST_GRAD_LP_PULL"))  score = Math.min(score, 300);
  if (flags.some((f) => f.code === "SELF_SNIPE"))         score = Math.min(score, 350);
  if (flags.filter((f) => f.severity === "CRITICAL").length >= 2) score = Math.min(score, 199);

  // Legend: 10+ launches, no flags, score >= 950
  if (launches.length >= 10 && flags.length === 0 && score >= 950) score = 1000;

  score = Math.max(0, Math.min(1000, score));
  const tier = scoreTier(score);

  // ── Metadata ──
  const graduated = launches.filter((l) => l.graduated);
  const metadata: ScoreMetadata = {
    totalLaunches: launches.length,
    successfulLaunches: launches.filter((l) => l.survivedHours >= 24 || l.graduated).length,
    rugCount: launches.filter((l) => l.devSoldPct50InFirstHour).length,
    graduatedCount: graduated.length,
    avgLongevityHours:
      launches.length > 0
        ? launches.reduce((a, l) => a + l.survivedHours, 0) / launches.length
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
  deployedAt: number,    // real timestamp from getTokensDeployedBy
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

  // Real survived hours — use liquidity as proxy for whether token is alive
  let lastActivityAt: number;
  if (graduationData.graduated) {
    lastActivityAt = now; // still live on Raydium
  } else if (graduationData.currentLiquidityUsd > 100) {
    lastActivityAt = now; // still has pump.fun liquidity
  } else {
    // Token appears dead — cap at time elapsed since deploy
    const elapsed = now - deployedAt;
    lastActivityAt = deployedAt + Math.min(elapsed, 3600 * 48);
  }
  const survivedHours = Math.max(0, (lastActivityAt - deployedAt) / 3600);

  // Dev sell timing from wallet transactions
  const devTxns = txns
    .filter((tx) => tx.feePayer === deployer && tx.timestamp >= deployedAt)
    .sort((a, b) => a.timestamp - b.timestamp);

  const devFirstSellHours = devTxns.length > 1
    ? (devTxns[1].timestamp - deployedAt) / 3600
    : null;

  // Real Streamflow lock data
  const devTokensLocked = streamflowData.hasActiveLocks;
  const devLockDays = streamflowData.avgLockDays;
  const devLockPct = streamflowData.hasActiveLocks ? 80 : null;

  // Bundle/self-snipe detection
  const snipeData = await detectSelfSnipe(mint, deployer, deployedAt);

  console.log(`[Launch] ${mint.slice(0,8)}... survived: ${survivedHours.toFixed(1)}h, graduated: ${graduationData.graduated}, sniped: ${snipeData.selfSniped}`);

  return {
    mint,
    deployer,
    deployedAt,
    lastActivityAt,
    survivedHours,
    graduated: graduationData.graduated,

    // Streamflow lock data
    devTokensLocked,
    devLockDays,
    devLockPct,
    devSoldBeforeLockExpiry: streamflowData.hasExpiredLocks && !streamflowData.hasActiveLocks,

    // Dev wallet behavior
    devAllocationPct: 5,
    devFirstSellHours,
    devSoldPct50InFirstHour: false,
    selfSniped: snipeData.selfSniped,

    // Post-graduation LP
    postGradLpLocked: false,
    postGradLpLockDays: null,
    postGradLpPulled: graduationData.lpPulled,
    postGradLpPulledHours: graduationData.lpPulledHoursAfterGrad,

    // Holders
    peakHolders: holderCount,
    holders7d:  Math.round(holderCount * 0.6),
    holders30d: Math.round(holderCount * 0.3),
    holders90d: Math.round(holderCount * 0.15),

    // On-chain hygiene
    mintRenounced: tokenMeta.mintRenounced,
    freezeAuthorityRevoked: tokenMeta.freezeAuthorityRevoked,
    telegramDeleted: false,
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
