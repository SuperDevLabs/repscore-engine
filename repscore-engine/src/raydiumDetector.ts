// ============================================================
// RepScore — Raydium Graduation Detection
// Verifies if a token actually migrated to Raydium
// instead of proxying from DexScreener liquidity amount
// ============================================================

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

// Raydium program IDs on Solana mainnet
const RAYDIUM_AMM_V4       = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CPMM         = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const RAYDIUM_CLMM         = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const PUMP_FUN_MIGRATION   = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";

// pump.fun program
const PUMP_FUN_PROGRAM     = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

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

// ── Main detection function ───────────────────────────────────

export async function detectRaydiumGraduation(
  mint: string
): Promise<GraduationResult> {
  try {
    // Run all detection in parallel
    const [raydiumPool, dexData, migrationTx] = await Promise.all([
      findRaydiumPool(mint),
      getDexScreenerData(mint),
      findMigrationTransaction(mint),
    ]);

    // No Raydium pool found
    if (!raydiumPool) {
      return {
        graduated: false,
        platform: "pump_fun_bonding",
        poolAddress: null,
        migrationSignature: migrationTx?.signature || null,
        migrationTimestamp: migrationTx?.timestamp || null,
        initialLpSol: 0,
        currentLiquidityUsd: dexData?.liquidityUsd || 0,
        lpPulled: false,
        lpPulledAt: null,
        lpPulledHoursAfterGrad: null,
      };
    }

    // Found Raydium pool — check if LP was pulled
    const lpPullData = await detectLpPull(
      raydiumPool.poolAddress,
      migrationTx?.timestamp || null
    );

    const solPrice = await getSolPrice();
    const initialLpSol = dexData ? dexData.liquidityUsd / solPrice : 0;

    console.log(`[Raydium] ${mint.slice(0,8)}... graduated: true, platform: ${raydiumPool.platform}, LP pulled: ${lpPullData.pulled}`);

    return {
      graduated: true,
      platform: raydiumPool.platform,
      poolAddress: raydiumPool.poolAddress,
      migrationSignature: migrationTx?.signature || null,
      migrationTimestamp: migrationTx?.timestamp || null,
      initialLpSol,
      currentLiquidityUsd: dexData?.liquidityUsd || 0,
      lpPulled: lpPullData.pulled,
      lpPulledAt: lpPullData.pulledAt,
      lpPulledHoursAfterGrad: lpPullData.pulled && migrationTx?.timestamp
        ? Math.round((lpPullData.pulledAt! - migrationTx.timestamp) / 3600)
        : null,
    };
  } catch (err: any) {
    console.warn("[Raydium] Detection failed:", err.message);
    return defaultResult();
  }
}

// ── Find Raydium pool for a token ─────────────────────────────

async function findRaydiumPool(mint: string): Promise<{
  poolAddress: string;
  platform: GraduationResult["platform"];
} | null> {

  // Method 1: Check DexScreener for Raydium pairs
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (res.ok) {
      const data = await res.json();
      const pairs = data?.pairs || [];

      // Look for Raydium pairs specifically
      const raydiumPair = pairs.find(
        (p: any) =>
          p.dexId === "raydium" &&
          p.chainId === "solana" &&
          (p.liquidity?.usd || 0) > 100 // at least $100 liquidity
      );

      if (raydiumPair) {
        const platform = raydiumPair.labels?.includes("CLMM")
          ? "raydium_clmm"
          : raydiumPair.labels?.includes("CPMM")
          ? "raydium_cpmm"
          : "raydium_amm";

        return {
          poolAddress: raydiumPair.pairAddress,
          platform,
        };
      }
    }
  } catch {}

  // Method 2: Check on-chain for Raydium AMM pool account
  // Raydium pools have the token mint in their account data
  try {
    const poolAddress = await findPoolOnChain(mint);
    if (poolAddress) {
      return { poolAddress, platform: "raydium_amm" };
    }
  } catch {}

  return null;
}

// ── Find pool on-chain ────────────────────────────────────────

async function findPoolOnChain(mint: string): Promise<string | null> {
  // Get mint token transactions and look for Raydium AMM interactions
  try {
    const sigs = await rpcCall("getSignaturesForAddress", [
      mint,
      { limit: 100, commitment: "finalized" },
    ]);

    if (!sigs || sigs.length === 0) return null;

    // Get recent transactions to find pool creation
    const sigStrings = sigs.slice(0, 50).map((s: any) => s.signature);
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

    for (const tx of txns) {
      if (!tx) continue;
      const accounts: string[] = tx.accountData?.map((a: any) => a.account) || [];

      // Check if this tx involves Raydium programs
      const hasRaydium = [RAYDIUM_AMM_V4, RAYDIUM_CPMM, RAYDIUM_CLMM].some(
        (id) => accounts.includes(id)
      );

      if (!hasRaydium) continue;

      // The pool address is typically a new account created in this tx
      // with a large SOL balance change
      const poolAccount = tx.accountData?.find(
        (a: any) =>
          a.nativeBalanceChange > 1e9 && // received > 1 SOL
          a.account !== tx.feePayer &&
          !accounts.slice(0, 3).includes(a.account)
      );

      if (poolAccount) return poolAccount.account;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Find migration transaction ────────────────────────────────

async function findMigrationTransaction(mint: string): Promise<{
  signature: string;
  timestamp: number;
} | null> {
  try {
    const sigs = await rpcCall("getSignaturesForAddress", [
      mint,
      { limit: 200, commitment: "finalized" },
    ]);

    if (!sigs || sigs.length === 0) return null;

    const sigStrings = sigs.slice(0, 100).map((s: any) => s.signature);
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

    // Find the migration tx — involves both pump.fun and Raydium programs
    // or the pump.fun migration program specifically
    for (const tx of txns) {
      if (!tx) continue;
      const accounts: string[] = tx.accountData?.map((a: any) => a.account) || [];

      const hasPumpMigration = accounts.includes(PUMP_FUN_MIGRATION);
      const hasRaydium = [RAYDIUM_AMM_V4, RAYDIUM_CPMM].some((id) =>
        accounts.includes(id)
      );

      if (hasPumpMigration || (hasRaydium && accounts.includes(PUMP_FUN_PROGRAM))) {
        return {
          signature: tx.signature,
          timestamp: tx.timestamp,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── Detect LP pull after graduation ──────────────────────────

async function detectLpPull(
  poolAddress: string,
  gradTimestamp: number | null
): Promise<{ pulled: boolean; pulledAt: number | null }> {
  try {
    // Check current pool liquidity via DexScreener
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`
    );

    if (!res.ok) return { pulled: false, pulledAt: null };
    const data = await res.json();
    const pair = data?.pair;

    if (!pair) return { pulled: false, pulledAt: null };

    const currentLiquidity = pair.liquidity?.usd || 0;

    // If pool exists but has < $500 liquidity — likely pulled
    if (currentLiquidity < 500 && gradTimestamp) {
      // Estimate pull time from pool transaction history
      const pullSigs = await rpcCall("getSignaturesForAddress", [
        poolAddress,
        { limit: 10, commitment: "finalized" },
      ]);

      const lastActivity = pullSigs?.[0]?.blockTime || null;

      return {
        pulled: true,
        pulledAt: lastActivity,
      };
    }

    return { pulled: false, pulledAt: null };
  } catch {
    return { pulled: false, pulledAt: null };
  }
}

// ── DexScreener data ──────────────────────────────────────────

async function getDexScreenerData(
  mint: string
): Promise<{ liquidityUsd: number; priceUsd: number } | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data?.pairs?.[0];
    if (!pair) return null;
    return {
      liquidityUsd: pair.liquidity?.usd || 0,
      priceUsd: parseFloat(pair.priceUsd || "0"),
    };
  } catch {
    return null;
  }
}

// ── SOL price helper ──────────────────────────────────────────

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

// ── Default result ────────────────────────────────────────────

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
