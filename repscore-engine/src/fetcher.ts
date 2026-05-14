// ============================================================
// RepScore Engine — Helius Data Fetcher
// ============================================================

import { HeliusTransaction } from "../types/index.js";

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

// Known addresses to skip
const SKIP_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

const BURN_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "11111111111111111111111111111111",
]);

// ── Core RPC helper ───────────────────────────────────────────

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

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Wallet signatures ─────────────────────────────────────────

export async function getWalletSignatures(
  wallet: string,
  limit = 500
): Promise<string[]> {
  const result = await rpcCall("getSignaturesForAddress", [
    wallet,
    { limit, commitment: "finalized" },
  ]);
  return (result || []).map((s: any) => s.signature);
}

// ── Wallet age (paginated) ────────────────────────────────────

export async function getWalletAge(wallet: string): Promise<number> {
  let lastSignature: string | undefined;
  let oldestBlockTime: number | null = null;
  const MAX_PAGES = 10;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: any = { limit: 1000, commitment: "finalized" };
    if (lastSignature) params.before = lastSignature;

    const result = await rpcCall("getSignaturesForAddress", [wallet, params]);
    if (!result || result.length === 0) break;

    const oldest = result[result.length - 1];
    if (oldest.blockTime) oldestBlockTime = oldest.blockTime;
    if (result.length < 1000) break;

    lastSignature = oldest.signature;
    await sleep(150);
  }

  if (!oldestBlockTime) return 0;
  return Math.floor((Date.now() / 1000 - oldestBlockTime) / 86400);
}

// ── Enhanced transactions ─────────────────────────────────────

export async function getEnhancedTransactions(
  signatures: string[]
): Promise<HeliusTransaction[]> {
  const CHUNK = 100;
  const results: HeliusTransaction[] = [];

  for (let i = 0; i < signatures.length; i += CHUNK) {
    const chunk = signatures.slice(i, i + CHUNK);
    try {
      const res = await fetch(
        `${HELIUS_API}/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transactions: chunk }),
        }
      );
      if (!res.ok) {
        console.warn(`[Fetcher] Enhanced txns failed: ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (Array.isArray(data)) results.push(...data);
    } catch (err: any) {
      console.warn(`[Fetcher] Enhanced txns error: ${err.message}`);
    }

    if (i + CHUNK < signatures.length) await sleep(100);
  }

  return results;
}

// ── Tokens deployed by wallet ─────────────────────────────────

export async function getTokensDeployedBy(
  wallet: string
): Promise<{ mint: string; deployedAt: number }[]> {
  const sigs = await getWalletSignatures(wallet, 1000);
  if (sigs.length === 0) return [];

  const results: { mint: string; deployedAt: number }[] = [];
  const seen = new Set<string>();
  const MAX_SIGS = 600;

  for (let i = 0; i < Math.min(sigs.length, MAX_SIGS); i += 200) {
    const chunk = sigs.slice(i, i + 200);
    let txns: any[] = [];

    try {
      txns = await getEnhancedTransactions(chunk);
    } catch {
      continue;
    }

    for (const tx of txns) {
      if (!tx || tx.transactionError) continue;
      if (tx.feePayer !== wallet) continue;

      // pump.fun uses type "CREATE", standard SPL uses "TOKEN_MINT"
      const isTokenCreation =
        tx.type === "CREATE" ||
        tx.type === "TOKEN_MINT" ||
        tx.type === "INITIALIZE_MINT";

      if (!isTokenCreation) continue;

      // Extract mint from token balance changes
      for (const acct of tx.accountData || []) {
        for (const change of acct.tokenBalanceChanges || []) {
          const mint = change.mint;
          if (mint && !seen.has(mint) && !SKIP_MINTS.has(mint)) {
            seen.add(mint);
            results.push({
              mint,
              deployedAt: tx.timestamp || Math.floor(Date.now() / 1000),
            });
          }
        }
      }
    }

    if (i + 200 < Math.min(sigs.length, MAX_SIGS)) await sleep(150);
  }

  console.log(`[Fetcher] Found ${results.length} token(s) deployed by ${wallet.slice(0, 8)}...`);
  return results;
}

// ── Token holder count ────────────────────────────────────────
// Uses getProgramAccounts with filters to avoid the 5M account limit

export async function getTokenHolderCount(mint: string): Promise<number> {
  try {
    // Use getTokenLargestAccounts which is safe — max 20 results
    const result = await rpcCall("getTokenLargestAccounts", [
      mint,
      { commitment: "finalized" },
    ]);
    const accounts = result?.value ?? [];

    if (accounts.length === 0) return 0;

    const totalAmount = accounts.reduce(
      (sum: number, a: any) => sum + parseFloat(a.uiAmount || 0), 0
    );
    if (totalAmount === 0) return 0;

    const MIN_PCT = 0.0001;   // 0.01% of supply
    const MIN_ABS = 1000;     // 1,000 tokens absolute

    const realHolders = accounts.filter((a: any) => {
      if (BURN_ADDRESSES.has(a.address)) return false;
      const amount = parseFloat(a.uiAmount || 0);
      return (amount / totalAmount) >= MIN_PCT && amount >= MIN_ABS;
    });

    return realHolders.length;
  } catch (err: any) {
    console.warn(`[Fetcher] getTokenHolderCount failed for ${mint.slice(0,8)}: ${err.message}`);
    return 0;
  }
}

// ── Token metadata ────────────────────────────────────────────

export async function getTokenMetadata(mint: string): Promise<{
  mintRenounced: boolean;
  freezeAuthorityRevoked: boolean;
  supply: number;
}> {
  try {
    const result = await rpcCall("getAccountInfo", [
      mint,
      { encoding: "jsonParsed" },
    ]);
    const info = result?.value?.data?.parsed?.info;
    if (!info) return { mintRenounced: false, freezeAuthorityRevoked: false, supply: 0 };

    return {
      mintRenounced: info.mintAuthority === null,
      freezeAuthorityRevoked: info.freezeAuthority === null,
      supply: parseInt(info.supply || "0"),
    };
  } catch {
    return { mintRenounced: false, freezeAuthorityRevoked: false, supply: 0 };
  }
}

// ── LP data from DexScreener ──────────────────────────────────

export async function getLpData(mint: string): Promise<{
  initialLpSol: number;
  lpLockDays: number | null;
  lpPulledAt: number | null;
  stillActive: boolean;
}> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );
    if (!res.ok) return defaultLpData();
    const data = await res.json();
    const pair = data?.pairs?.[0];
    if (!pair) return defaultLpData();

    const liquidityUsd = pair.liquidity?.usd ?? 0;
    const solPrice = 150;
    return {
      initialLpSol: liquidityUsd / solPrice,
      lpLockDays: null,
      lpPulledAt: null,
      stillActive: liquidityUsd > 500,
    };
  } catch {
    return defaultLpData();
  }
}

function defaultLpData() {
  return { initialLpSol: 0, lpLockDays: null, lpPulledAt: null, stillActive: false };
}

// ── Rug detection ─────────────────────────────────────────────

export async function detectLiquidityPull(
  mint: string,
  deployedAt: number
): Promise<{ wasRugged: boolean; ruggedAt: number | null }> {
  try {
    const lp = await getLpData(mint);
    const ageHours = (Date.now() / 1000 - deployedAt) / 3600;
    if (!lp.stillActive && ageHours < 72) {
      return { wasRugged: true, ruggedAt: deployedAt + ageHours * 3600 };
    }
    return { wasRugged: false, ruggedAt: null };
  } catch {
    return { wasRugged: false, ruggedAt: null };
  }
}

// ── Wallet volume ─────────────────────────────────────────────

export async function getWalletVolume(
  txns: HeliusTransaction[],
  wallet: string
): Promise<number> {
  let totalSol = 0;
  for (const tx of txns) {
    for (const transfer of tx.nativeTransfers || []) {
      if (
        transfer.fromUserAccount === wallet ||
        transfer.toUserAccount === wallet
      ) {
        totalSol += transfer.amount / 1e9;
      }
    }
  }
  return totalSol;
}

// ── Linked wallet detection ───────────────────────────────────

export async function detectLinkedWallets(
  wallet: string,
  txns: HeliusTransaction[]
): Promise<string[]> {
  const fundingWallets = new Set<string>();
  for (const tx of txns) {
    for (const transfer of tx.nativeTransfers || []) {
      if (
        transfer.toUserAccount === wallet &&
        transfer.amount / 1e9 > 0.1 &&
        transfer.fromUserAccount !== wallet
      ) {
        fundingWallets.add(transfer.fromUserAccount);
      }
    }
  }
  return [...fundingWallets].slice(0, 10);
}
// ============================================================
// RepScore Engine — Fetcher additions for v2
// Add this to the BOTTOM of your existing fetcher.ts
// (getTokenLargestHolders is new)
// Also update getWalletSignatures default limit from 600 → 1000
// in the engine.ts call (already done in engine.ts v2)
// ============================================================

// ── Token largest holders with addresses ──────────────────────
// Returns top 20 holders with address + balance.
// Used by engine.ts to compute Gini coefficient and
// cross-token holder overlap sets.

export async function getTokenLargestHolders(
  mint: string
): Promise<{ address: string; balance: number }[]> {
  const BURN_ADDRESSES = new Set([
    "1nc1nerator11111111111111111111111111111111",
    "So11111111111111111111111111111111111111112",
    "11111111111111111111111111111111",
    // pump.fun bonding curve vault — not a real holder
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ35MKDkc4i3", // pump.fun program
  ]);

  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "getTokenLargestAccounts",
          params: [mint, { commitment: "finalized" }],
        }),
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const accounts = data?.result?.value ?? [];
    if (accounts.length === 0) return [];

    const totalAmount = accounts.reduce(
      (sum: number, a: any) => sum + parseFloat(a.uiAmount || 0), 0
    );
    if (totalAmount === 0) return [];

    return accounts
      .filter((a: any) => {
        if (BURN_ADDRESSES.has(a.address)) return false;
        const amount = parseFloat(a.uiAmount || 0);
        // Must hold at least 0.01% of supply
        return (amount / totalAmount) >= 0.0001 && amount > 0;
      })
      .map((a: any) => ({
        address: a.address,
        balance: parseFloat(a.uiAmount || 0),
      }));
  } catch (err: any) {
    console.warn(`[Fetcher] getTokenLargestHolders failed for ${mint.slice(0, 8)}: ${err.message}`);
    return [];
  }
}
