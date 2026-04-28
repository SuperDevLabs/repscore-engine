// ============================================================
// RepScore Engine — CLI
// Usage: npm run score <wallet_address>
// ============================================================

import { computeRepScore } from "./engine.js";

const wallet = process.argv[2];

if (!wallet) {
  console.error("Usage: npm run score <wallet_address>");
  process.exit(1);
}

console.log(`\n🧬 RepScore Engine — repscore.xyz`);
console.log(`Scoring wallet: ${wallet}\n`);

try {
  const result = await computeRepScore(wallet);

  const tierColors: Record<string, string> = {
    LEGEND: "\x1b[93m",
    VERIFIED: "\x1b[32m",
    ESTABLISHED: "\x1b[33m",
    UNPROVEN: "\x1b[36m",
    FLAGGED: "\x1b[31m",
    BLACKLISTED: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  const color = tierColors[result.tier] || "";

  console.log(`${color}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}`);
  console.log(`${color}  SCORE: ${result.score}/1000   TIER: ${result.tier}   ROLE: ${result.role}${reset}`);
  console.log(`${color}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}\n`);

  console.log("Component breakdown:");
  const comps = result.components;
  for (const [key, comp] of Object.entries(comps)) {
    const bar = "█".repeat(Math.round(comp.raw / 10)) + "░".repeat(10 - Math.round(comp.raw / 10));
    console.log(`  ${key.padEnd(20)} [${bar}] ${comp.raw}/100 (×${comp.weight} = ${comp.weighted.toFixed(1)})`);
    comp.signals.slice(0, 2).forEach((s) => console.log(`    → ${s}`));
  }

  if (result.flags.length > 0) {
    console.log(`\n⚠  Flags (${result.flags.length}):`);
    result.flags.forEach((f) => {
      console.log(`  [${f.severity}] ${f.code}: ${f.description}`);
    });
  } else {
    console.log(`\n✓  No flags detected`);
  }

  console.log(`\nMetadata:`);
  console.log(`  Launches: ${result.metadata.totalLaunches} (${result.metadata.successfulLaunches} successful, ${result.metadata.rugCount} rugged)`);
  console.log(`  Wallet age: ${result.metadata.walletAgeDays} days`);
  console.log(`  Total volume: ${result.metadata.totalVolumeSol.toFixed(2)} SOL`);
  console.log(`  Scored at: ${result.cachedAt}\n`);
} catch (err: any) {
  console.error(`\n✗ Scoring failed: ${err.message}\n`);
  process.exit(1);
}
