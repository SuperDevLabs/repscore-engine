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
// pump.fun controls LP during bonding curve — devs CANNOT lock it.
// Devs CAN lock their token allocation via Streamflow/Realms.
// After graduation, devs CAN lock Raydium LP.
// We score what devs actually control.

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

  // ── Dev token locks (Streamflow / Realms) ──
  // Voluntarily locking dev allocation is the strongest trust signal.
  // Nobody forces this — doing it is a real commitment.
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
    if (avgLockDays >= 180) {
      raw += 20;
      signals.push(`Avg dev token lock: ${Math.round(avgLockDays)}d — strong commitment`);
    } else if (avgLockDays >= 90) {
      raw += 14;
      signals.push(`Avg dev token lock: ${Math.round(avgLockDays)}d`);
    } else if (avgLockDays >= 30) {
      raw += 8;
      signals.push(`Avg dev token lock: ${Math.round(avgLockDays)}d`);
    } else {
      raw += 3;
      signals.push(`Short dev token lock: avg ${Math.round(avgLockDays)}d`);
    }
  }

  // Lock % bonus — locking 100% of allocation is ideal
  const locksWithPct = launches.filter((l) => l.devLockPct !== null);
  if (locksWithPct.length > 0) {
    const avgLockPct = locksWithPct.reduce((a, l) => a + (l.devLockPct ?? 0), 0) / locksWithPct.length;
    if (avgLockPct >= 90) {
      raw += 10;
      signals.push(`${Math.round(avgLockPct)}% of dev allocation locked`);
    } else if (avgLockPct >= 50) {
      raw += 5;
      signals.push(`${Math.round(avgLockPct)}% of dev allocation locked`);
    }
  }

  // Sold before lock expired — worst possible signal
  const soldBeforeExpiry = launches.filter((l) => l.devSoldBeforeLockExpiry);
  if (soldBeforeExpiry.length > 0) {
    raw -= soldBeforeExpiry.length * 25;
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
  if (gradRate >= 0.5) {
    raw += 15;
    signals.push(`${pct(gradRate)} graduation rate to Raydium`);
  } else if (gradRate > 0) {
    raw += Math.round(gradRate * 15);
    signals.push(`${graduated.length}/${launches.length} tokens graduated to Raydium`);
  } else {
    signals.push("No tokens graduated to Raydium");
  }

  // ── Post-graduation Raydium LP lock ──
  // After graduation devs CAN lock Raydium LP — reward them for it
  const postGradLocked = launches.filter((l) => l.graduated && l.postGradLpLocked);
  if (postGradLocked.length > 0) {
    raw += Math.min(postGradLocked.length * 8, 16);
    const avgPostLockDays = postGradLocked
      .filter((l) => l.postGradLpLockDays !== null)
      .reduce((a, l) => a + (l.postGradLpLockDays ?? 0), 0) / postGradLocked.length;
    signals.push(`Raydium LP locked on ${postGradLocked.length} graduated token(s)${avgPostLockDays > 0 ? ` (avg ${Math.round(avgPostLockDays)}d)` : ''}`);
  }

  // ── Post-graduation LP pulls ──
  const postGradPulls = launches.filter((l) => l.graduated && l.postGradLpPulled);
  if (postGradPulls.length > 0) {
    raw -= Math.min(postGradPulls.length * 20, 50);
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
  const avgDevAlloc =
    launches.reduce((a, l) => a + l.devAllocationPct, 0) / launches.length;
  if (avgDevAlloc <= 3) {
    raw += 10;
    signals.push(`Low dev allocation: avg ${avgDevAlloc.toFixed(1)}% at launch`);
  } else if (avgDevAlloc <= 8) {
    raw += 5;
    signals.push(`Moderate dev allocation: avg ${avgDevAlloc.toFixed(1)}%`);
  } else if (avgDevAlloc > 15) {
    raw -= 15;
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
  const sellTimes = launches
    .filter((l) => l.devFirstSellHours !== null)
    .map((l) => l.devFirstSellHours as number);

  if (sellTimes.length > 0) {
    const avgSellHours = sellTimes.reduce((a, h) => a + h, 0) / sellTimes.length;
    if (avgSellHours >= 48) {
      raw += 10;
      signals.push(`Dev held avg ${formatHours(avgSellHours)} before first sell`);
    } else if (avgSellHours >= 8) {
      raw += 5;
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
