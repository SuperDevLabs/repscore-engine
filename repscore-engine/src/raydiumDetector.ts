// ============================================================
// RepScore — Raydium Graduation Detection (pump.fun native)
// Primary signal: pump.fun migration program interaction
// Secondary: DexScreener Raydium pair check
// ============================================================

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

// pump.fun migration program — fires when bonding curve completes
const PUMP_FUN_MIGRATION = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const PUMP_FUN_PROGRAM   = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Raydium program IDs
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const RAYDIUM_CLMM   = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

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
  mint: string
): Promise<GraduationResult> {
  try {
    // PRIMARY: Check if pump.fun migration program touched this token
    // This is the most reliable signal — fires exactly when bonding completes
    const migrationTx = await findMigrationTransaction(mint);

    if (migrationTx) {
      // Confirmed graduated — now check DexScreener for LP pull detection
      const dexData = await getDexScreenerData(mint);
      const currentLiquidityUsd = dexData?.liquidityUsd || 0;
      const solPrice = await getSolPrice();
      const initialLpSol = currentLiquidityUsd > 0 ? currentLiquidityUsd / solPrice : 12; // ~$1800 at graduation

      // LP pulled if graduated but now has very low liquidity
      const lpPulled = currentLiquidityUsd < 500 && currentLiquidityUsd > 0;
      const lpPulledHours = lpPulled && migrationTx.timestamp
        ? Math.round((Date.now() / 1000 - migrationTx.timestamp) / 3600)
        : null;

      console.log(`[Raydium] ${mint.slice(0,8)}... GRADUATED via migration program, liquidity: $${currentLiquidityUsd.toFixed(0)}`);

      return {
        graduated: true,
        platform: "raydium_amm",
        poolAddress: null,
        migrationSignature: migrationTx.signature,
        migrationTimestamp: migrationTx.timestamp,
        initialLpSol,
        currentLiquidityUsd,
        lpPulled,
        lpPulledAt: lpPulled ? Date.now() / 1000 : null,
        lpPulledHoursAfterGrad: lpPulledHours,
      };
    }

    // SECONDARY: Check DexScreener for Raydium pair
    // Catches cases where migration program check missed
    const dexData = await getDexScreenerData(mint);
    if (dexData?.isRaydium) {
      const solPrice = await getSolPrice();
      const initialLpSol = (dexData.liquidityUsd || 0) / solPrice;
      const lpPulled = dexData.liquidityUsd < 500 && dexData.liquidityUsd > 0;

      console.log(`[Raydium] ${mint.slice(0,8)}... GRADUATED via DexScreener Raydium pair`);

      return {
        graduated: true,
        platform: dexData.platform || "raydium_amm",
        poolAddress: dexData.pairAddress || null,
        migrationSignature: null,
        migrationTimestamp: null,
        initialLpSol,
        currentLiquidityUsd: dexData.liquidityUsd,
        lpPulled,
        lpPulledAt: lpPulled ? Date.now() / 1000 : null,
        lpPulledHoursAfterGrad: null,
      };
    }

    console.log(`[Raydium] ${mint.slice(0,8)}... not graduated`);
    return defaultResult();

  } catch (err: any) {
    console.warn("[Raydium] Detection failed:", err.message);
    return defaultResult();
  }
}

// ── Find pump.fun migration transaction ───────────────────────
// The migration program fires exactly once when a token graduates

async function findMigrationTransaction(mint: string): Promise<{
  signature: string;
  timestamp: number;
} | null> {
  try {
    // Get signatures for the MINT ADDRESS
    // The migration tx will show up in the mint's transaction history
    const sigs = await rpcCall("getSignaturesForAddress", [
      mint,
      { limit: 100, commitment: "finalized" },
    ]);

    if (!sigs || sigs.length === 0) return null;

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
      if (!tx || tx.transactionError) continue;

      const accounts: string[] = (tx.accountData || []).map((a: any) => a.account);

      // Check for pump.fun migration program
      const hasMigration = accounts.includes(PUMP_FUN_MIGRATION);

      // Also check for Raydium programs in same tx as pump.fun
      const hasRaydium = [RAYDIUM_AMM_V4, RAYDIUM_CPMM, RAYDIUM_CLMM].some(id =>
        accounts.includes(id)
      );

      if (hasMigration || (hasRaydium && accounts.includes(PUMP_FUN_PROGRAM))) {
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

// ── DexScreener check ─────────────────────────────────────────

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

    // Look for any Raydium pair
    const raydiumPair = pairs.find(
      (p: any) => p.dexId === "raydium" && p.chainId === "solana"
    );

    if (raydiumPair) {
      const platform = raydiumPair.labels?.includes("CLMM")
        ? "raydium_clmm"
        : raydiumPair.labels?.includes("CPMM")
        ? "raydium_cpmm"
        : "raydium_amm";

      return {
        liquidityUsd: raydiumPair.liquidity?.usd || 0,
        isRaydium: true,
        pairAddress: raydiumPair.pairAddress || null,
        platform,
      };
    }

    // Not on Raydium — return pump.fun liquidity if any
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
