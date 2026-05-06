// ============================================================
// RepScore — Bundle / Self-Snipe Detection
// Detects if dev wallet bought tokens in same block as launch
// ============================================================

const HELIUS_API = `https://api.helius.xyz/v0`;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

export interface BundleDetectionResult {
  selfSniped: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  evidence: string[];
  devBuySlot: number | null;
  launchSlot: number | null;
  slotDifference: number | null;
  devBuyAmountSol: number | null;
  devBuyWithinSeconds: number | null;
}

// ── Main detection function ───────────────────────────────────

export async function detectSelfSnipe(
  mint: string,
  deployer: string,
  deployedAt: number // unix timestamp
): Promise<BundleDetectionResult> {
  try {
    const evidence: string[] = [];

    // Step 1: Get the token creation transaction (launch slot)
    const launchInfo = await getTokenLaunchInfo(mint);
    if (!launchInfo) {
      return noSnipeResult();
    }

    const { launchSlot, launchSignature, launchTimestamp } = launchInfo;

    // Step 2: Get transactions FROM the deployer wallet around launch time
    // Look at a 60-second window after launch
    const devTxns = await getDevTransactionsAroundLaunch(
      deployer,
      launchTimestamp,
      mint
    );

    if (devTxns.length === 0) {
      return noSnipeResult();
    }

    // Step 3: Check if any dev transactions are buys of this token
    // in the same block or within 3 seconds
    let selfSniped = false;
    let confidence: BundleDetectionResult["confidence"] = "NONE";
    let devBuySlot: number | null = null;
    let devBuyAmountSol: number | null = null;
    let devBuyWithinSeconds: number | null = null;

    for (const tx of devTxns) {
      // Check if this is a buy of the launched token
      const isBuyOfToken = tx.tokenTransfers?.some(
        (t: any) =>
          t.mint === mint && t.toUserAccount === deployer
      );

      if (!isBuyOfToken) continue;

      const slotDiff = Math.abs((tx.slot || 0) - launchSlot);
      const timeDiff = Math.abs(tx.timestamp - launchTimestamp);

      // Get SOL amount spent
      const solSpent = tx.nativeTransfers
        ?.filter((t: any) => t.fromUserAccount === deployer)
        ?.reduce((a: number, t: any) => a + t.amount / 1e9, 0) || 0;

      devBuySlot = tx.slot;
      devBuyAmountSol = solSpent;
      devBuyWithinSeconds = timeDiff;

      // Same block = definitive self-snipe
      if (slotDiff === 0) {
        selfSniped = true;
        confidence = "HIGH";
        evidence.push(`Dev bought in SAME BLOCK as launch (slot ${launchSlot})`);
        evidence.push(`Dev spent ${solSpent.toFixed(3)} SOL buying own token at launch`);
        break;
      }

      // Within 2 slots (~0.8 seconds) = very likely bundled
      if (slotDiff <= 2) {
        selfSniped = true;
        confidence = "HIGH";
        evidence.push(`Dev bought within ${slotDiff} slot(s) of launch`);
        evidence.push(`Dev spent ${solSpent.toFixed(3)} SOL — likely jito bundle`);
        break;
      }

      // Within 5 seconds = suspicious
      if (timeDiff <= 5) {
        selfSniped = true;
        confidence = "MEDIUM";
        evidence.push(`Dev bought within ${timeDiff}s of launch`);
        evidence.push(`Possible bot/bundle — ${solSpent.toFixed(3)} SOL`);
        break;
      }

      // Within 30 seconds = low confidence snipe
      if (timeDiff <= 30) {
        selfSniped = true;
        confidence = "LOW";
        evidence.push(`Dev bought within ${timeDiff}s of launch (${solSpent.toFixed(3)} SOL)`);
        break;
      }
    }

    return {
      selfSniped,
      confidence,
      evidence,
      launchSlot,
      devBuySlot,
      slotDifference: devBuySlot !== null ? Math.abs(devBuySlot - launchSlot) : null,
      devBuyAmountSol,
      devBuyWithinSeconds,
    };
  } catch (err: any) {
    console.warn("[BundleDetector] Error:", err.message);
    return noSnipeResult();
  }
}

// ── Get token launch info ─────────────────────────────────────

async function getTokenLaunchInfo(mint: string): Promise<{
  launchSlot: number;
  launchSignature: string;
  launchTimestamp: number;
} | null> {
  try {
    // Get the first transaction for this mint (creation tx)
    const sigs = await rpcCall("getSignaturesForAddress", [
      mint,
      { limit: 1000, commitment: "finalized" },
    ]);

    if (!sigs || sigs.length === 0) return null;

    // The oldest transaction = token creation
    const oldest = sigs[sigs.length - 1];
    if (!oldest.slot || !oldest.blockTime) return null;

    return {
      launchSlot: oldest.slot,
      launchSignature: oldest.signature,
      launchTimestamp: oldest.blockTime,
    };
  } catch {
    return null;
  }
}

// ── Get dev transactions around launch ────────────────────────

async function getDevTransactionsAroundLaunch(
  deployer: string,
  launchTimestamp: number,
  mint: string
): Promise<any[]> {
  try {
    // Get deployer signatures around launch time
    const sigs = await rpcCall("getSignaturesForAddress", [
      deployer,
      { limit: 100, commitment: "finalized" },
    ]);

    if (!sigs || sigs.length === 0) return [];

    // Filter to signatures within 60 seconds of launch
    const nearLaunch = sigs.filter((s: any) => {
      if (!s.blockTime) return false;
      const diff = s.blockTime - launchTimestamp;
      return diff >= -5 && diff <= 60; // 5s before to 60s after
    });

    if (nearLaunch.length === 0) return [];

    // Fetch full transaction details
    const sigStrings = nearLaunch.map((s: any) => s.signature);
    const res = await fetch(
      `${HELIUS_API}/transactions/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: sigStrings }),
      }
    );

    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
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

function noSnipeResult(): BundleDetectionResult {
  return {
    selfSniped: false,
    confidence: "NONE",
    evidence: [],
    launchSlot: null,
    devBuySlot: null,
    slotDifference: null,
    devBuyAmountSol: null,
    devBuyWithinSeconds: null,
  };
}
