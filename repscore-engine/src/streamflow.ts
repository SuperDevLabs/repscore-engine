// ============================================================
// RepScore — Streamflow Lock Detection
// Checks if a dev wallet has locked tokens via Streamflow
// ============================================================

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

// Streamflow program IDs on Solana mainnet
const STREAMFLOW_PROGRAM_IDS = [
  "strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m", // v3 streams
  "Hs8HVS69FMxN2SjbZBR3Xr2GGxmjbx7wHBVLNFMDRzE", // token lock
  "FGjLaVo5zLGdzCxMo9gu9tXr1kzTToKd8C8K7YS5hNM1", // v2
];

export interface StreamflowLockData {
  hasLocks: boolean;
  lockCount: number;
  totalLockedTokens: number;
  locks: LockInfo[];
  shortestLockDays: number | null;
  longestLockDays: number | null;
  avgLockDays: number | null;
  hasExpiredLocks: boolean;
  hasActiveLocks: boolean;
}

export interface LockInfo {
  streamId: string;
  mint: string;
  amount: number;
  startTime: number;
  endTime: number;
  lockDays: number;
  isActive: boolean;
  isExpired: boolean;
  cancelable: boolean;
}

// ── Main detection function ───────────────────────────────────

export async function detectStreamflowLocks(
  wallet: string
): Promise<StreamflowLockData> {
  try {
    // Approach: scan wallet transactions for Streamflow program interactions
    // This works without the SDK by looking at on-chain data directly
    const locks = await fetchLocksFromChain(wallet);

    if (locks.length === 0) {
      return emptyLockData();
    }

    const now = Date.now() / 1000;
    const activeLocks = locks.filter((l) => l.endTime > now);
    const expiredLocks = locks.filter((l) => l.endTime <= now);

    const lockDays = locks.map((l) => l.lockDays).filter((d) => d > 0);
    const totalLockedTokens = locks.reduce((a, l) => a + l.amount, 0);

    return {
      hasLocks: locks.length > 0,
      lockCount: locks.length,
      totalLockedTokens,
      locks,
      shortestLockDays: lockDays.length > 0 ? Math.min(...lockDays) : null,
      longestLockDays: lockDays.length > 0 ? Math.max(...lockDays) : null,
      avgLockDays:
        lockDays.length > 0
          ? Math.round(lockDays.reduce((a, b) => a + b, 0) / lockDays.length)
          : null,
      hasExpiredLocks: expiredLocks.length > 0,
      hasActiveLocks: activeLocks.length > 0,
    };
  } catch (err: any) {
    console.warn("[Streamflow] Detection failed:", err.message);
    return emptyLockData();
  }
}

// ── Fetch locks from chain ────────────────────────────────────

async function fetchLocksFromChain(wallet: string): Promise<LockInfo[]> {
  // Get wallet signatures and look for Streamflow program interactions
  const sigs = await rpcCall("getSignaturesForAddress", [
    wallet,
    { limit: 200, commitment: "finalized" },
  ]);

  if (!sigs || sigs.length === 0) return [];

  // Filter to signatures that might be Streamflow interactions
  const sigStrings = sigs.map((s: any) => s.signature);

  // Fetch transactions in batches
  const CHUNK = 50;
  const locks: LockInfo[] = [];
  const seenStreams = new Set<string>();

  for (let i = 0; i < Math.min(sigStrings.length, 200); i += CHUNK) {
    const chunk = sigStrings.slice(i, i + CHUNK);

    const res = await fetch(
      `https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: chunk }),
      }
    );

    if (!res.ok) continue;
    const txns = await res.json();

    for (const tx of txns) {
      if (!tx || tx.transactionError) continue;

      // Check if this transaction involves a Streamflow program
      const accountKeys: string[] = tx.accountData?.map((a: any) => a.account) || [];
      const isStreamflow = STREAMFLOW_PROGRAM_IDS.some((id) =>
        accountKeys.includes(id)
      );

      if (!isStreamflow) continue;

      // Extract stream account from the transaction
      // The stream PDA is typically the first non-wallet, non-program account
      const streamAccount = accountKeys.find(
        (k) =>
          k !== wallet &&
          !STREAMFLOW_PROGRAM_IDS.includes(k) &&
          k !== "11111111111111111111111111111111" &&
          k !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      );

      if (!streamAccount || seenStreams.has(streamAccount)) continue;
      seenStreams.add(streamAccount);

      // Fetch the stream account data to get lock details
      const lockInfo = await fetchStreamAccount(streamAccount, wallet);
      if (lockInfo) locks.push(lockInfo);

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 100));
    }

    if (i + CHUNK < sigStrings.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return locks;
}

async function fetchStreamAccount(
  streamAccount: string,
  wallet: string
): Promise<LockInfo | null> {
  try {
    const result = await rpcCall("getAccountInfo", [
      streamAccount,
      { encoding: "base64" },
    ]);

    if (!result?.value) return null;

    const data = result.value.data;
    if (!data || !data[0]) return null;

    // Decode base64 account data
    const buf = Buffer.from(data[0], "base64");
    if (buf.length < 200) return null;

    // Parse Streamflow stream account layout
    // Offsets based on Streamflow v3 stream account structure
    const now = Date.now() / 1000;

    // Read timestamps (stored as u64 little-endian at known offsets)
    const startTime = Number(buf.readBigUInt64LE(8));
    const endTime = Number(buf.readBigUInt64LE(16));
    const depositedAmount = Number(buf.readBigUInt64LE(48));

    // Validate timestamps are reasonable (after 2020, before 2040)
    if (startTime < 1577836800 || endTime < 1577836800) return null;
    if (startTime > 2208988800 || endTime > 2208988800) return null;

    const lockDays = Math.round((endTime - startTime) / 86400);
    if (lockDays < 0 || lockDays > 3650) return null; // sanity check

    // Check cancelable flag (byte at offset 80)
    const cancelableBySender = buf[80] === 1;

    return {
      streamId: streamAccount,
      mint: "unknown", // would need more parsing for mint
      amount: depositedAmount / 1e9,
      startTime,
      endTime,
      lockDays,
      isActive: endTime > now,
      isExpired: endTime <= now,
      cancelable: cancelableBySender,
    };
  } catch {
    return null;
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

// ── Helpers ───────────────────────────────────────────────────

function emptyLockData(): StreamflowLockData {
  return {
    hasLocks: false,
    lockCount: 0,
    totalLockedTokens: 0,
    locks: [],
    shortestLockDays: null,
    longestLockDays: null,
    avgLockDays: null,
    hasExpiredLocks: false,
    hasActiveLocks: false,
  };
}
