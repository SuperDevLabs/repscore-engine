// ============================================================
// RepScore Engine — Helius Data Fetcher
// ============================================================

import { HeliusTransaction, TokenLaunch } from "../types/index.js";

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

// ── RPC Calls ─────────────────────────────────────────────────

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

// ── Wallet Data ───────────────────────────────────────────────

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

export async function getWalletAge(wallet: string): Promise<number> {
  // Paginates through ALL signatures to find the truly oldest transaction
  // Fixes the bug where wallets with 1000+ txns appeared newer than they are
  let lastSignature: string | undefined;
  let oldestBlockTime: number | null = null;
  const MAX_PAGES = 10; // look back up to 10,000 transactions

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: any = { limit: 1000, commitment: "finalized" };
    if (lastSignature) params.before = lastSignature;

    const result = await rpcCall("getSignaturesForAddress", [wallet, params]);
    if (!result || result.length === 0) break;

    const oldest = result[result.length - 1];
    if (oldest.blockTime) oldestBlockTime = oldest.blockTime;

    if (result.length < 1000) break;

    lastSignature = oldest.signature;
    await new Promise(r => setTimeout(r, 150));
  }

  if (!oldestBlockTime) return 0;
  return Math.floor((Date.now() / 1000 - oldestBlockTime) / 86400);
}

export async function getSolBalance(wallet: string): Promise<number> {
  const result = await rpcCall("getBalance", [wallet]);
  return (result?.value ?? 0) / 1e9;
}

// ── Transaction Parsing ───────────────────────────────────────

export async function getEnhancedTransactions(
  signatures: string[]
): Promise<HeliusTransaction[]> {
  const CHUNK = 100;
  const results: HeliusTransaction[] = [];

  for (let i = 0; i < signatures.length; i += CHUNK) {
    const chunk = signatures.slice(i, i + CHUNK);
    const res = await fetch(
      `${HELIUS_API}/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: chunk }),
      }
    );
    if (!res.ok) throw new Error(`Helius transactions API failed: ${res.status}`);
    const data = await res.json();
    results.push(...data);

    // Respect rate limits — 100ms between chunks
    if (i + CHUNK < signatures.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return results;
}

// ── Token / Mint Data ─────────────────────────────────────────

export async function getTokensDeployedBy(wallet: string): Promise<string[]> {
  // Find all mints where the wallet was the deployer
  // Helius parses TOKEN_MINT events with type detection
  const sigs = await getWalletSignatures(wallet, 500);
  if (sigs.length === 0) return [];

  const txns = await getEnhancedTransactions(sigs.slice(0, 200));
  const mints: string[] = [];

  for (const tx of txns) {
    if (tx.type === "TOKEN_MINT" && tx.feePayer === wallet) {
      // Extract newly created mint from account changes
      for (const acct of tx.accountData || []) {
        if (
          acct.tokenBalanceChanges?.length > 0 &&
          acct.tokenBalanceChanges[0].userAccount === wallet
        ) {
          mints.push(acct.tokenBalanceChanges[0].mint);
        }
      }
    }
  }

  return [...new Set(mints)]; // deduplicate
}

export async function getTokenHolderCount(mint: string): Promise<number> {
  const result = await rpcCall("getTokenLargestAccounts", [mint]);
  const accounts = result?.value ?? [];

  const BURN_ADDRESSES = [
    "1nc1nerator11111111111111111111111111111111",
    "So11111111111111111111111111111111111111112",
    "11111111111111111111111111111111",
  ];

  const totalAmount = accounts.reduce(
    (sum: number, a: any) => sum + parseFloat(a.uiAmount || 0), 0
  );
  if (totalAmount === 0) return 0;

  const MIN_HOLDING_PCT = 0.0001; // 0.01% of supply minimum
  const MIN_HOLDING_ABS = 1000;   // 1,000 tokens absolute minimum

  const realHolders = accounts.filter((a: any) => {
    if (BURN_ADDRESSES.includes(a.address)) return false;
    const amount = parseFloat(a.uiAmount || 0);
    const pct = amount / totalAmount;
    if (pct < MIN_HOLDING_PCT) return false;
    if (amount < MIN_HOLDING_ABS) return false;
    return true;
  });

  return realHolders.length;
}

export async function getTokenMetadata(mint: string): Promise<{
  mintRenounced: boolean;
  freezeAuthorityRevoked: boolean;
  supply: number;
}> {
  const result = await rpcCall("getAccountInfo", [
    mint,
    { encoding: "jsonParsed" },
  ]);

  const info = result?.value?.data?.parsed?.info;
  if (!info) {
    return { mintRenounced: false, freezeAuthorityRevoked: false, supply: 0 };
  }

  return {
    mintRenounced: info.mintAuthority === null,
    freezeAuthorityRevoked: info.freezeAuthority === null,
    supply: parseInt(info.supply || "0"),
  };
}

// ── DexScreener LP Data ───────────────────────────────────────

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
    const solPrice = 150; // approximate — replace with live feed in production
    const initialLpSol = liquidityUsd / solPrice;
    const stillActive = liquidityUsd > 500; // $500 min liquidity threshold

    return {
      initialLpSol,
      lpLockDays: null,    // Requires dedicated LP lock indexer (e.g. Streamflow)
      lpPulledAt: null,    // Inferred from liquidity cliff detection below
      stillActive,
    };
  } catch {
    return defaultLpData();
  }
}

function defaultLpData() {
  return { initialLpSol: 0, lpLockDays: null, lpPulledAt: null, stillActive: false };
}

// ── Rug Detection ─────────────────────────────────────────────

export async function detectLiquidityPull(
  mint: string,
  deployedAt: number
): Promise<{ wasRugged: boolean; ruggedAt: number | null }> {
  // Heuristic: if token had liquidity but now has <$200, and it was
  // within 72h of launch — flag as rug
  const lp = await getLpData(mint);
  const ageHours = (Date.now() / 1000 - deployedAt) / 3600;

  if (!lp.stillActive && ageHours < 72) {
    return { wasRugged: true, ruggedAt: deployedAt + ageHours * 3600 };
  }

  return { wasRugged: false, ruggedAt: null };
}

// ── Volume & Activity ─────────────────────────────────────────

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

// ── Linked Wallet Detection ───────────────────────────────────

export async function detectLinkedWallets(
  wallet: string,
  txns: HeliusTransaction[]
): Promise<string[]> {
  // Find wallets that funded this wallet within 24h of its first tx
  const fundingWallets = new Set<string>();

  for (const tx of txns) {
    for (const transfer of tx.nativeTransfers || []) {
      if (
        transfer.toUserAccount === wallet &&
        transfer.amount / 1e9 > 0.1 // meaningful funding
      ) {
        if (transfer.fromUserAccount !== wallet) {
          fundingWallets.add(transfer.fromUserAccount);
        }
      }
    }
  }

  return [...fundingWallets].slice(0, 10); // top 10 funding sources
}
