// ============================================================
// RepScore — Raydium Graduation Detection (pump.fun native v3)
// Checks deployer wallet transactions for migration events
// Falls back to DexScreener for confirmation
// ============================================================

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

// pump.fun migration program — fires when bonding curve completes
const PUMP_FUN_MIGRATION = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const PUMP_FUN_PROGRAM   = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Raydium programs
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const RAYDIUM_CLMM   = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const RAYDIUM_IDS    = new Set([RAYDIUM_AMM_V4, RAYDIUM_CPMM, RAYDIUM_CLMM]);

export interface GraduationResult {
  graduated: boolean;
  platform: "raydium_amm" | "raydium_cpmm" | "raydium_clmm" | "pump_fun_bonding" | "none";
  poolAddress: string | null;
  migrationSignature: string | null;
  migrationTimestamp: number | null;
  initialLpSol: number;
  currentLiquidityUsd: number;
  lpPulled: boolean;
  lpPulledAt: number | null;
  lpPulledHoursAfterGrad: number | null;
}

// ── Main detection ────────────────────────────────────────────

export async function detectRaydiumGraduation(
  mint: string,
  deployer?: string,
  deployedAt?: number
): Promise<GraduationResult> {
  try {
    // Run DexScreener check in parallel with on-chain check
    const [dexData, migrationTx] = await Promise.all([
      getDexScreenerData(mint),
      findMigrationTx(mint, deployer, deployedAt),
    ]);

    const graduated = dexData?.isRaydium || !!migrationTx;

    if (!graduated) {
      // Not graduated — but get current liquidity for survived hours estimation
      return {
        ...defaultResult(),
        currentLiquidityUsd: dexData?.liquidityUsd || 0,
      };
    }

    // Graduated!
    const solPrice = await getSolPrice();
    const currentLiquidityUsd = dexData?.liquidityUsd || 0;
    const initialLpSol = currentLiquidityUsd > 0
      ? currentLiquidityUsd / solPrice
      : 12; // ~85 SOL graduation threshold approximation

    // LP pulled if very low liquidity post-graduation
    const lpPulled = graduated && currentLiquidityUsd < 500;
    const gradTimestamp = migrationTx?.timestamp || null;
    const lpPulledHours = lpPulled && gradTimestamp
      ? Math.round((Date.now() / 1000 - gradTimestamp) / 3600)
      : null;

    const platform = dexData?.platform || "raydium_amm";

    console.log(`[Raydium] ${mint.slice(0,8)}... GRADUATED platform:${platform} liquidity:$${currentLiquidityUsd.toFixed(0)} lpPulled:${lpPulled}`);

    return {
      graduated: true,
      platform,
      poolAddress: dexData?.pairAddress || null,
      migrationSignature: migrationTx?.signature || null,
      migrationTimestamp: gradTimestamp,
      initialLpSol,
      currentLiquidityUsd,
      lpPulled,
      lpPulledAt: lpPulled ? Date.now() / 1000 : null,
      lpPulledHoursAfterGrad: lpPulledHours,
    };

  } catch (err: any) {
    console.warn("[Raydium] Detection error:", err.message);
    return defaultResult();
  }
}

// ── Find migration transaction ────────────────────────────────
// Checks both the deployer wallet and the mint address

async function findMigrationTx(
  mint: string,
  deployer?: string,
  deployedAt?: number
): Promise<{ signature: string; timestamp: number } | null> {

  // Strategy 1: Check deployer wallet transactions around launch time
  // Migration happens within hours of launch so we look at recent deployer txns
  if (deployer && deployedAt) {
    try {
      const result = await findMigrationInWallet(deployer, mint, deployedAt);
      if (result) return result;
    } catch {}
  }

  // Strategy 2: Check mint address transaction history directly
  try {
    const result = await findMigrationInMintHistory(mint);
    if (result) return result;
  } catch {}

  return null;
}

async function findMigrationInWallet(
  deployer: string,
  mint: string,
  deployedAt: number
): Promise<{ signature: string; timestamp: number } | null> {
  // Get deployer signatures after token launch
  const sigs = await rpcCall("getSignaturesForAddress", [
    deployer,
    { limit: 100, commitment: "finalized" },
  ]);

  if (!sigs || sigs.length === 0) return null;

  // Filter to signatures after deployment
  const afterLaunch = sigs.filter(
    (s: any) => s.blockTime && s.blockTime >= deployedAt
  );

  if (afterLaunch.length === 0) return null;

  const sigStrings = afterLaunch.slice(0, 50).map((s: any) => s.signature);

  const res = await fetch(
    `${HELIUS_API}/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: sigStrings }),
    }
  );

  if (!res.ok) return null;
  const txns = await res.json();

  return parseMigrationFromTxns(txns, mint);
}

async function findMigrationInMintHistory(
  mint: string
): Promise<{ signature: string; timestamp: number } | null> {
  const sigs = await rpcCall("getSignaturesForAddress", [
    mint,
    { limit: 50, commitment: "finalized" },
  ]);

  if (!sigs || sigs.length === 0) return null;

  const sigStrings = sigs.map((s: any) => s.signature);

  const res = await fetch(
    `${HELIUS_API}/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: sigStrings }),
    }
  );

  if (!res.ok) return null;
  const txns = await res.json();

  return parseMigrationFromTxns(txns, mint);
}

function parseMigrationFromTxns(
  txns: any[],
  mint: string
): { signature: string; timestamp: number } | null {
  for (const tx of txns) {
    if (!tx || tx.transactionError) continue;

    const accounts: string[] = (tx.accountData || []).map((a: any) => a.account);

    // Check for pump.fun migration program
    const hasMigration = accounts.includes(PUMP_FUN_MIGRATION);

    // Check for Raydium + pump.fun in same tx
    const hasRaydium = [...RAYDIUM_IDS].some(id => accounts.includes(id));
    const hasPump = accounts.includes(PUMP_FUN_PROGRAM);

    // Also check if this tx involves our specific mint
    const involvesMint = accounts.includes(mint) ||
      (tx.accountData || []).some((a: any) =>
        (a.tokenBalanceChanges || []).some((t: any) => t.mint === mint)
      );

    if ((hasMigration || (hasRaydium && hasPump)) && involvesMint) {
      return {
        signature: tx.signature,
        timestamp: tx.timestamp,
      };
    }

    // Broader check: any Raydium interaction involving this mint
    if (hasRaydium && involvesMint) {
      return {
        signature: tx.signature,
        timestamp: tx.timestamp,
      };
    }
  }
  return null;
}

// ── DexScreener ───────────────────────────────────────────────

async function getDexScreenerData(mint: string): Promise<{
  liquidityUsd: number;
  isRaydium: boolean;
  pairAddress: string | null;
  platform: GraduationResult["platform"] | null;
} | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data?.pairs || [];

    // Check for any Raydium pair
    const raydiumPair = pairs.find(
      (p: any) => p.dexId === "raydium" && p.chainId === "solana"
    );

    if (raydiumPair) {
      const platform: GraduationResult["platform"] =
        raydiumPair.labels?.includes("CLMM") ? "raydium_clmm" :
        raydiumPair.labels?.includes("CPMM") ? "raydium_cpmm" :
        "raydium_amm";

      return {
        liquidityUsd: raydiumPair.liquidity?.usd || 0,
        isRaydium: true,
        pairAddress: raydiumPair.pairAddress || null,
        platform,
      };
    }

    // Not Raydium — return pump.fun liquidity for survived hours estimation
    const anyPair = pairs[0];
    return {
      liquidityUsd: anyPair?.liquidity?.usd || 0,
      isRaydium: false,
      pairAddress: null,
      platform: null,
    };
  } catch {
    return null;
  }
}

// ── SOL price ─────────────────────────────────────────────────

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    if (!res.ok) return 150;
    const data = await res.json();
    return data?.solana?.usd || 150;
  } catch {
    return 150;
  }
}

// ── RPC helper ────────────────────────────────────────────────

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

// ── Default ───────────────────────────────────────────────────

function defaultResult(): GraduationResult {
  return {
    graduated: false,
    platform: "none",
    poolAddress: null,
    migrationSignature: null,
    migrationTimestamp: null,
    initialLpSol: 0,
    currentLiquidityUsd: 0,
    lpPulled: false,
    lpPulledAt: null,
    lpPulledHoursAfterGrad: null,
  };
}
