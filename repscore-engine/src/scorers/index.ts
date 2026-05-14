// ============================================================
// RepScore Engine — Score Modules v2
// Changes: time-decay weighting throughout, Gini coefficient
// in holder retention, cluster signals in wallet history,
// cross-token overlap in community signals
// ============================================================

import { ComponentScore, ScoreFlag, TokenLaunch } from "../types/index.js";

// ── Longevity tier thresholds (hours) ─────────────────────────

const LONGEVITY_TIERS = [
  { hours: 168, points: 50, label: "7d+"  },
  { hours:  72, points: 35, label: "72h+" },
  { hours:  48, points: 28, label: "48h+" },
  { hours:  24, points: 20, label: "24h+" },
  { hours:   8, points: 12, label: "8h+"  },
  { hours:   4, points:  8, label: "4h+"  },
  { hours:   1, points:  2, label: "1h+"  },
];

function longevityPoints(hours: number): { points: number; label: string } {
  for (const tier of LONGEVITY_TIERS) {
    if (hours >= tier.hours) return { points: tier.points, label: tier.label };
  }
  return { points: 0, label: "<1h" };
}

// ── 1. Launch History (30%) — with time-decay ─────────────────

export function scoreLaunchHistory(
  launches: TokenLaunch[],
  flags: ScoreFlag[]
): ComponentScore {
  const signals: string[] = [];

  if (launches.length === 0) {
    signals.push("No prior launches detected");
    return { raw: 40, weighted: 40 * 0.3, weight: 0.3, signals };
  }

  // ── Time-decay weighted longevity ──
  // Recent launches count more than old ones.
  // A rug 2 years ago hurts much less than one last month.
  let weightedLongevityPoints = 0;
  let totalWeight = 0;

  const longevityScores = launches.map((l) => {
    const { points, label } = longevityPoints(l.survivedHours);
    const w = l.decayWeight ?? 1;
    weightedLongevityPoints += points * w;
    totalWeight += w;
    return { points, label, hours: l.survivedHours };
  });

  const avgLongevityPoints = totalWeight > 0
    ? weightedLongevityPoints / totalWeight
    : 0;

  let raw = Math.round((avgLongevityPoints / 50) * 60);

  const best = longevityScores.reduce((a, b) => (b.hours > a.hours ? b : a));
  const avgHours = longevityScores.reduce((a, s) => a + s.hours, 0) / launches.length;
  signals.push(`Avg longevity: ${formatHours(avgHours)} (decay-weighted)`);
  signals.push(`Best token: ${formatHours(best.hours)} (${best.label})`);

  // ── Graduation bonus (decay-weighted) ──
  const graduatedWeight = launches
    .filter((l) => l.graduated)
    .reduce((a, l) => a + (l.decayWeight ?? 1), 0);
  const gradBonus = Math.min(Math.round(graduatedWeight * 40), 24);
  if (gradBonus > 0) {
    raw += gradBonus;
    const graduatedCount = launches.filter((l) => l.graduated).length;
    signals.push(`${graduatedCount} token(s) graduated to Raydium`);
  }

  // ── Volume / launch count bonuses ──
  if (launches.length >= 10) { raw += 8; signals.push("10+ launch veteran"); }
  else if (launches.length >= 5) { raw += 4; signals.push(`${launches.length} launches`); }
  else { signals.push(`${launches.length} launch(es) on record`); }

  // ── Dev dump penalties (time-decay weighted) ──
  // Recent dumps are far more damaging than old ones.
  let weightedDumpPenalty = 0;
  const earlyDumps = launches.filter((l) => l.devSoldPct50InFirstHour);
  earlyDumps.forEach((l) => {
    weightedDumpPenalty += 15 * (l.decayWeight ?? 1) * launches.length;
  });
  if (earlyDumps.length > 0) {
    const penalty = Math.min(Math.round(weightedDumpPenalty), 40);
    raw -= penalty;
    const recency = earlyDumps.some((l) => (l.decayWeight ?? 0) > 0.8) ? " (recent)" : " (historical)";
    signals.push(`Dev dumped >50% in first hour on ${earlyDumps.length} launch(es)${recency}`);
    if (earlyDumps.length >= 2) {
      flags.push({
        severity: "CRITICAL",
        code: "SERIAL_EARLY_DUMP",
        description: `Dev wallet dumped >50% of allocation within 1 hour on ${earlyDumps.length} launches`,
      });
    }
  }

  // ── Self-snipe penalty (decay-weighted) ──
  const sniped = launches.filter((l) => l.selfSniped);
  if (sniped.length > 0) {
    const snipePenalty = Math.min(
      Math.round(sniped.reduce((a, l) => a + 10 * (l.decayWeight ?? 1) * launches.length, 0)),
      25
    );
    raw -= snipePenalty;
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

// ── 2. Liquidity Behavior (25%) ───────────────────────────────

export function scoreLiquidityBehavior(
  launches: TokenLaunch[],
  flags: ScoreFlag[]
): ComponentScore {
  const signals: string[] = [];

  if (launches.length === 0) {
    return { raw: 40, weighted: 40 * 0.25, weight: 0.25, signals: ["No launches to evaluate"] };
  }

  let raw = 50;

  // ── Dev token locks ──
  const lockedLaunches = launches.filter((l) => l.devTokensLocked);
  if (lockedLaunches.length === launches.length && launches.length > 0) {
    raw += 20;
    signals.push(`Dev tokens locked on all launches`);
  } else if (lockedLaunches.length > 0) {
    raw += 10;
    signals.push(`Dev tokens locked on ${lockedLaunches.length}/${launches.length} launches`);
  } else {
    signals.push("No dev token locks detected");
  }

  // Lock duration bonus
  const locksWithDuration = launches.filter((l) => l.devLockDays !== null);
  if (locksWithDuration.length > 0) {
    const avgLockDays = locksWithDuration.reduce((a, l) => a + (l.devLockDays ?? 0), 0) / locksWithDuration.length;
    if (avgLockDays >= 180)     { raw += 20; signals.push(`Avg dev token lock: ${Math.round(avgLockDays)}d — strong commitment`); }
    else if (avgLockDays >= 90) { raw += 14; signals.push(`Avg dev token lock: ${Math.round(avgLockDays)}d`); }
    else if (avgLockDays >= 30) { raw += 8;  signals.push(`Avg dev token lock: ${Math.round(avgLockDays)}d`); }
    else                        { raw += 3;  signals.push(`Short dev token lock: avg ${Math.round(avgLockDays)}d`); }
  }

  // Lock % bonus
  const locksWithPct = launches.filter((l) => l.devLockPct !== null);
  if (locksWithPct.length > 0) {
    const avgLockPct = locksWithPct.reduce((a, l) => a + (l.devLockPct ?? 0), 0) / locksWithPct.length;
    if (avgLockPct >= 90)      { raw += 10; signals.push(`${Math.round(avgLockPct)}% of dev allocation locked`); }
    else if (avgLockPct >= 50) { raw += 5;  signals.push(`${Math.round(avgLockPct)}% of dev allocation locked`); }
  }

  // Sold before lock expired — worst signal, decay-amplified if recent
  const soldBeforeExpiry = launches.filter((l) => l.devSoldBeforeLockExpiry);
  if (soldBeforeExpiry.length > 0) {
    const penalty = soldBeforeExpiry.reduce((a, l) => a + 25 * (l.decayWeight ?? 1) * launches.length, 0);
    raw -= Math.min(Math.round(penalty), 60);
    signals.push(`Dev sold before lock expired on ${soldBeforeExpiry.length} launch(es)`);
    flags.push({
      severity: "CRITICAL",
      code: "SOLD_BEFORE_LOCK_EXPIRY",
      description: `Dev sold tokens before lock expiry on ${soldBeforeExpiry.length} launch(es) — violated own commitment`,
    });
  }

  // ── Graduation rate ──
  const graduated = launches.filter((l) => l.graduated);
  const gradRate = graduated.length / launches.length;
  if (gradRate >= 0.5)     { raw += 15; signals.push(`${pct(gradRate)} graduation rate to Raydium`); }
  else if (gradRate > 0)   { raw += Math.round(gradRate * 15); signals.push(`${graduated.length}/${launches.length} tokens graduated`); }
  else                     { signals.push("No tokens graduated to Raydium"); }

  // Post-graduation LP lock
  const postGradLocked = launches.filter((l) => l.graduated && l.postGradLpLocked);
  if (postGradLocked.length > 0) {
    raw += Math.min(postGradLocked.length * 8, 16);
    const avgPostLockDays = postGradLocked.filter((l) => l.postGradLpLockDays !== null)
      .reduce((a, l) => a + (l.postGradLpLockDays ?? 0), 0) / postGradLocked.length;
    signals.push(`Raydium LP locked on ${postGradLocked.length} graduated token(s)${avgPostLockDays > 0 ? ` (avg ${Math.round(avgPostLockDays)}d)` : ''}`);
  }

  // Post-graduation LP pulls (decay-weighted — recent pulls hurt far more)
  const postGradPulls = launches.filter((l) => l.graduated && l.postGradLpPulled);
  if (postGradPulls.length > 0) {
    const pullPenalty = postGradPulls.reduce((a, l) => a + 20 * (l.decayWeight ?? 1) * launches.length, 0);
    raw -= Math.min(Math.round(pullPenalty), 50);
    signals.push(`Post-graduation LP pulled on ${postGradPulls.length} launch(es)`);
    const quickPulls = postGradPulls.filter((l) => l.postGradLpPulledHours !== null && l.postGradLpPulledHours < 48);
    if (quickPulls.length > 0) {
      raw -= quickPulls.length * 10;
      signals.push(`${quickPulls.length} LP pull(s) within 48h of graduation`);
      flags.push({ severity: "CRITICAL", code: "POST_GRAD_LP_PULL", description: `Pulled Raydium LP within 48h of graduation on ${quickPulls.length} token(s)` });
    } else {
      flags.push({ severity: "HIGH", code: "RAYDIUM_LP_PULL", description: `Pulled Raydium liquidity on ${postGradPulls.length} graduated token(s)` });
    }
  }

  // Dev allocation
  const avgDevAlloc = launches.reduce((a, l) => a + l.devAllocationPct, 0) / launches.length;
  if (avgDevAlloc <= 3)       { raw += 10; signals.push(`Low dev allocation: avg ${avgDevAlloc.toFixed(1)}%`); }
  else if (avgDevAlloc <= 8)  { raw += 5;  signals.push(`Moderate dev allocation: avg ${avgDevAlloc.toFixed(1)}%`); }
  else if (avgDevAlloc > 15)  {
    raw -= 15;
    signals.push(`High dev allocation: avg ${avgDevAlloc.toFixed(1)}% at launch`);
    flags.push({ severity: "HIGH", code: "HIGH_DEV_ALLOC", description: `Dev holds avg ${avgDevAlloc.toFixed(1)}% of supply at launch` });
  } else {
    signals.push(`Dev allocation: avg ${avgDevAlloc.toFixed(1)}%`);
  }

  // Dev sell timing (decay-weighted)
  const sellTimes = launches.filter((l) => l.devFirstSellHours !== null).map((l) => l.devFirstSellHours as number);
  if (sellTimes.length > 0) {
    const avgSellHours = sellTimes.reduce((a, h) => a + h, 0) / sellTimes.length;
    if (avgSellHours >= 48)    { raw += 10; signals.push(`Dev held avg ${formatHours(avgSellHours)} before first sell`); }
    else if (avgSellHours >= 8){ raw += 5;  signals.push(`Dev held avg ${formatHours(avgSellHours)} before first sell`); }
    else if (avgSellHours < 1) {
      raw -= 15;
      signals.push(`Dev sold within 1h on most launches`);
      flags.push({ severity: "HIGH", code: "FAST_DEV_SELL", description: `Dev wallet sold within 1 hour of launch on average` });
    } else {
      signals.push(`Dev first sell: avg ${formatHours(avgSellHours)} after launch`);
    }
  }

  raw = clamp(raw);
  return { raw, weighted: raw * 0.25, weight: 0.25, signals };
}

// ── 3. Holder Retention (20%) — with Gini coefficient ────────

export function scoreHolderRetention(
  launches: TokenLaunch[],
  flags: ScoreFlag[],
  giniScores: number[] = []
): ComponentScore {
  const signals: string[] = [];

  if (launches.length === 0) {
    return { raw: 40, weighted: 40 * 0.2, weight: 0.2, signals: ["No launches to evaluate"] };
  }

  let raw = 50;

  // ── Gini coefficient — holder concentration (improvement #4) ──
  // Low Gini = holders well distributed = healthy community
  // High Gini = whales dominate = dump risk
  if (giniScores.length > 0) {
    const avgGini = giniScores.reduce((a, b) => a + b, 0) / giniScores.length;
    if (avgGini < 0.5) {
      raw += 15;
      signals.push(`Healthy holder distribution (Gini: ${avgGini.toFixed(2)})`);
    } else if (avgGini < 0.7) {
      raw += 5;
      signals.push(`Moderate holder concentration (Gini: ${avgGini.toFixed(2)})`);
    } else if (avgGini < 0.85) {
      raw -= 10;
      signals.push(`High holder concentration (Gini: ${avgGini.toFixed(2)})`);
      flags.push({
        severity: "MEDIUM",
        code: "HIGH_HOLDER_CONCENTRATION",
        description: `Top wallets hold a disproportionate share — Gini coefficient ${avgGini.toFixed(2)}`,
      });
    } else {
      raw -= 25;
      signals.push(`Extreme whale concentration (Gini: ${avgGini.toFixed(2)})`);
      flags.push({
        severity: "HIGH",
        code: "WHALE_CONCENTRATION",
        description: `Extreme holder concentration detected — Gini ${avgGini.toFixed(2)} — dump risk very high`,
      });
    }
  }

  // ── Standard 7d/30d retention (decay-weighted) ──
  const measurable7d  = launches.filter((l) => l.survivedHours >= 168 && l.peakHolders > 0);
  const measurable30d = launches.filter((l) => l.survivedHours >= 720 && l.peakHolders > 0);

  if (measurable7d.length > 0) {
    // Weight retention by decay — recent tokens' retention matters more
    const weightedRetention7d = measurable7d.reduce((a, l) => {
      const ret = l.holders7d / Math.max(l.peakHolders, 1);
      return a + ret * (l.decayWeight ?? 1);
    }, 0);
    const totalW = measurable7d.reduce((a, l) => a + (l.decayWeight ?? 1), 0);
    const retention7d = weightedRetention7d / Math.max(totalW, 1);

    if (retention7d >= 0.5)       { raw += 20; signals.push(`Strong 7d retention: ${pct(retention7d)}`); }
    else if (retention7d >= 0.25) { raw += 10; signals.push(`Moderate 7d retention: ${pct(retention7d)}`); }
    else if (retention7d < 0.1)   {
      raw -= 15;
      signals.push(`Poor 7d retention: ${pct(retention7d)}`);
      flags.push({ severity: "HIGH", code: "LOW_7D_RETENTION", description: "Avg 7-day holder retention below 10%" });
    } else {
      signals.push(`7d retention: ${pct(retention7d)}`);
    }
  } else {
    signals.push("Insufficient data for 7d retention");
  }

  if (measurable30d.length > 0) {
    const weightedRetention30d = measurable30d.reduce((a, l) => {
      return a + (l.holders30d / Math.max(l.peakHolders, 1)) * (l.decayWeight ?? 1);
    }, 0);
    const totalW = measurable30d.reduce((a, l) => a + (l.decayWeight ?? 1), 0);
    const retention30d = weightedRetention30d / Math.max(totalW, 1);

    if (retention30d >= 0.3)      { raw += 15; signals.push(`Strong 30d retention: ${pct(retention30d)}`); }
    else if (retention30d >= 0.1) { raw += 5;  signals.push(`Moderate 30d retention: ${pct(retention30d)}`); }
    else if (retention30d < 0.05) {
      raw -= 10;
      signals.push(`Poor 30d retention: ${pct(retention30d)}`);
      flags.push({ severity: "MEDIUM", code: "LOW_30D_RETENTION", description: "Avg 30-day holder retention below 5%" });
    }
  }

  // Holder cliff
  const cliffLaunches = launches.filter(
    (l) => l.peakHolders > 50 && l.holders7d / Math.max(l.peakHolders, 1) < 0.05
  );
  if (cliffLaunches.length > 0) {
    raw -= 15;
    signals.push(`Holder cliff on ${cliffLaunches.length} launch(es)`);
    flags.push({ severity: "HIGH", code: "HOLDER_CLIFF", description: "95%+ holder exit detected" });
  }

  // Peak holder count
  const avgPeak = launches.reduce((a, l) => a + l.peakHolders, 0) / launches.length;
  if (avgPeak >= 500)      { raw += 10; signals.push(`Peak community: avg ${Math.round(avgPeak).toLocaleString()} holders`); }
  else if (avgPeak >= 100) { raw += 5;  signals.push(`Peak community: avg ${Math.round(avgPeak)} holders`); }
  else                     { signals.push(`Peak community: avg ${Math.round(avgPeak)} holders`); }

  raw = clamp(raw);
  return { raw, weighted: raw * 0.2, weight: 0.2, signals };
}

// ── 4. Community Signals (15%) — with cross-token overlap ─────

export function scoreCommunitySignals(
  launches: TokenLaunch[],
  flags: ScoreFlag[]
): ComponentScore {
  const signals: string[] = [];
  let raw = 50;

  if (launches.length === 0) {
    return { raw: 40, weighted: 40 * 0.15, weight: 0.15, signals: ["No launches to evaluate"] };
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
      flags.push({ severity: "HIGH", code: "TELEGRAM_DELETED", description: "Community channel deleted after >50% of launches" });
    }
  }

  // Mint authority
  const renouncedMints = launches.filter((l) => l.mintRenounced);
  if (renouncedMints.length === launches.length) {
    raw += 15;
    signals.push("Mint authority renounced on all launches");
  } else if (renouncedMints.length > 0) {
    raw += 7;
    signals.push(`Mint renounced on ${renouncedMints.length}/${launches.length} launches`);
  } else if (launches.filter((l) => !l.graduated).length > 0) {
    raw -= 10;
    signals.push("Mint authority not renounced on non-graduated tokens");
    flags.push({ severity: "MEDIUM", code: "MINT_AUTHORITY_ACTIVE", description: "Mint authority active on non-graduated tokens" });
  }

  // Freeze authority
  const frozenRevoked = launches.filter((l) => l.freezeAuthorityRevoked);
  if (frozenRevoked.length === launches.length && launches.length > 0) {
    raw += 8;
    signals.push("Freeze authority revoked — fully trustless");
  } else if (frozenRevoked.length > 0) {
    raw += 3;
    signals.push(`Freeze authority revoked on ${frozenRevoked.length}/${launches.length} launches`);
  } else {
    signals.push("Freeze authority active (standard for most tokens)");
  }

  raw = clamp(raw);
  return { raw, weighted: raw * 0.15, weight: 0.15, signals };
}

// ── 5. Wallet History (10%) — with deep cluster analysis ──────

export function scoreWalletHistory(
  walletAgeDays: number,
  totalVolumeSol: number,
  totalTxns: number,
  linkedWallets: string[],
  clusterAnalysis: { riskScore: number; clusterSize: number; signals: string[] },
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

  // Tx count
  if (totalTxns >= 1000)     { raw += 10; signals.push(`${totalTxns.toLocaleString()} lifetime txns`); }
  else if (totalTxns >= 100) { raw += 5;  signals.push(`${totalTxns.toLocaleString()} lifetime txns`); }
  else if (totalTxns < 10)   { raw -= 10; signals.push("Very low transaction history"); }

  // Volume
  if (totalVolumeSol >= 1000)    { raw += 10; signals.push(`${totalVolumeSol.toLocaleString()} SOL lifetime volume`); }
  else if (totalVolumeSol >= 100){ raw += 5; }

  // ── Deep cluster analysis (improvement #2) ──
  // Surface the cluster signals from the orchestrator
  for (const sig of clusterAnalysis.signals) {
    signals.push(sig);
  }

  if (clusterAnalysis.riskScore >= 80) {
    raw -= 30;
    flags.push({
      severity: "HIGH",
      code: "SYBIL_CLUSTER_HIGH",
      description: `Large coordinated wallet cluster detected (${clusterAnalysis.clusterSize} linked wallets across 2 hops)`,
    });
  } else if (clusterAnalysis.riskScore >= 50) {
    raw -= 20;
    flags.push({
      severity: "MEDIUM",
      code: "SYBIL_CLUSTER_MEDIUM",
      description: `Medium wallet cluster detected (${clusterAnalysis.clusterSize} linked wallets) — possible multi-wallet operation`,
    });
  } else if (clusterAnalysis.riskScore >= 25) {
    raw -= 10;
    flags.push({
      severity: "LOW",
      code: "MULTI_WALLET_CLUSTER",
      description: `${clusterAnalysis.clusterSize} linked funding wallets detected`,
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
  if (hours < 1)   return `${Math.round(hours * 60)}m`;
  if (hours < 24)  return `${Math.round(hours)}h`;
  if (hours < 168) return `${(hours / 24).toFixed(1)}d`;
  return `${(hours / 168).toFixed(1)}w`;
}


