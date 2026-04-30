// ============================================================
// RepScore Engine — Orchestrator (pump.fun native)
// ============================================================

import {
  RepScore, ScoreFlag, ScoreTier,
  ScoreMetadata, TokenLaunch, WalletRole,
} from "./types/index.js";

import {
  getWalletSignatures, getWalletAge, getEnhancedTransactions,
  getTokensDeployedBy, getLpData, detectLiquidityPull,
  getTokenMetadata, getWalletVolume, detectLinkedWallets,
  getTokenHolderCount,
} from "./fetcher.js";

import {
  scoreLaunchHistory, scoreLiquidityBehavior,
  scoreHolderRetention, scoreCommunitySignals, scoreWalletHistory,
} from "./scorers/index.js";

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

  const [mintAddresses, totalVolumeSol, linkedWallets] = await Promise.all([
    getTokensDeployedBy(wallet),
    getWalletVolume(txns, wallet),
    detectLinkedWallets(wallet, txns),
  ]);

  const launches: TokenLaunch[] = await Promise.all(
    mintAddresses.slice(0, 20).map((mint) => buildLaunchRecord(mint, wallet, txns))
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
    walletAgeDays,
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
  deployer: string,
  txns: any[]
): Promise<TokenLaunch> {
  const [lpData, rugData, tokenMeta, holderCount] = await Promise.all([
    getLpData(mint),
    detectLiquidityPull(mint, Date.now() / 1000 - 86400 * 30),
    getTokenMetadata(mint),
    getTokenHolderCount(mint),
  ]);

  // Estimate survived hours from token activity
  // In production: index this from a dedicated token snapshot service
  const deployedAt = Date.now() / 1000 - 86400 * 14; // approximate
  const lastActivityAt = lpData.stillActive
    ? Date.now() / 1000
    : deployedAt + 3600 * 6; // approximate if not active
  const survivedHours = (lastActivityAt - deployedAt) / 3600;

  // Estimate dev behavior from transaction patterns
  // In production: parse dev wallet txns specifically
  const devTxns = txns.filter((tx) => tx.feePayer === deployer);
  const devFirstSellHours = devTxns.length > 1
    ? (devTxns[devTxns.length - 2].timestamp - deployedAt) / 3600
    : null;

  const isGraduated = lpData.stillActive && lpData.initialLpSol > 10;

  return {
    mint,
    deployer,
    deployedAt,
    lastActivityAt,
    survivedHours: Math.max(0, survivedHours),
    graduated: isGraduated,

    // Dev token locks — requires Streamflow/Realms indexer
    // Defaulted to false until lock detection is implemented
    devTokensLocked: false,
    devLockDays: null,
    devLockPct: null,
    devSoldBeforeLockExpiry: false,

    // Dev wallet behavior
    devAllocationPct: 5,            // default — refine with supply analysis
    devFirstSellHours,
    devSoldPct50InFirstHour: false, // refine with wallet tx analysis
    selfSniped: false,              // refine with bundle detection

    // Post-graduation Raydium LP
    postGradLpLocked: false,        // refine with Raydium LP lock indexer
    postGradLpLockDays: null,
    postGradLpPulled: rugData.wasRugged && isGraduated,
    postGradLpPulledHours: rugData.wasRugged ? 24 : null,

    // Holders
    peakHolders: holderCount,
    holders7d: Math.round(holderCount * 0.6),
    holders30d: Math.round(holderCount * 0.3),
    holders90d: Math.round(holderCount * 0.15),

    // On-chain hygiene
    mintRenounced: tokenMeta.mintRenounced,
    freezeAuthorityRevoked: tokenMeta.freezeAuthorityRevoked,
    telegramDeleted: false, // requires social indexer
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
