// ============================================================
// RepScore Engine — Core Types (pump.fun native v2)
// repscore.xyz
// ============================================================

export type ScoreTier =
  | "LEGEND"
  | "VERIFIED"
  | "ESTABLISHED"
  | "UNPROVEN"
  | "FLAGGED"
  | "BLACKLISTED";

export type WalletRole = "DEV" | "TRADER" | "BOTH" | "UNKNOWN";

export interface RepScore {
  wallet: string;
  score: number;          // 0–1000
  tier: ScoreTier;
  role: WalletRole;
  components: ScoreComponents;
  flags: ScoreFlag[];
  metadata: ScoreMetadata;
  cachedAt: string;
}

export interface ScoreComponents {
  launchHistory:     ComponentScore; // 30%
  liquidityBehavior: ComponentScore; // 25%
  holderRetention:   ComponentScore; // 20%
  communitySignals:  ComponentScore; // 15%
  walletHistory:     ComponentScore; // 10%
}

export interface ComponentScore {
  raw: number;
  weighted: number;
  weight: number;
  signals: string[];
}

export interface ScoreFlag {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  code: string;
  description: string;
  detectedAt?: string;
}

export interface ScoreMetadata {
  totalLaunches: number;
  successfulLaunches: number;
  rugCount: number;
  graduatedCount: number;
  avgLongevityHours: number;
  avgHolderRetention7d: number;
  avgHolderRetention30d: number;
  totalTransactions: number;
  totalVolumeSol: number;
  lastActivityAt: string;
  // ── v2 additions ──
  holderConcentrationGini: number | null;   // avg Gini coefficient across launches (0=equal, 1=whale)
  crossTokenHolderOverlap: number;          // fraction of holders shared across launches (0–1)
  walletClusterSize: number;                // total linked wallets found across 2 hops
  sociallyVerified: boolean;                // wallet has completed social verification
}

// ── TokenLaunch — pump.fun native ────────────────────────────

export interface TokenLaunch {
  mint: string;
  deployer: string;
  deployedAt: number;             // unix timestamp

  // Longevity
  lastActivityAt: number;
  survivedHours: number;
  graduated: boolean;

  // Dev token lock (Streamflow / Realms — voluntary)
  devTokensLocked: boolean;
  devLockDays: number | null;
  devLockPct: number | null;
  devSoldBeforeLockExpiry: boolean;

  // Dev wallet behavior
  devAllocationPct: number;
  devFirstSellHours: number | null;
  devSoldPct50InFirstHour: boolean;
  selfSniped: boolean;

  // Post-graduation LP (Raydium — dev CAN control this)
  postGradLpLocked: boolean;
  postGradLpLockDays: number | null;
  postGradLpPulled: boolean;
  postGradLpPulledHours: number | null;

  // Holders
  peakHolders: number;
  holders7d: number;
  holders30d: number;
  holders90d: number;

  // On-chain hygiene
  mintRenounced: boolean;
  freezeAuthorityRevoked: boolean;
  telegramDeleted: boolean;

  // ── v2 additions ──
  decayWeight: number;              // time-decay weight (higher = more recent launch)
  giniCoefficient: number | null;   // holder concentration for this token (populated after fetch)
}

// ── Raw on-chain data structures ──────────────────────────────

export interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  fee: number;
  feePayer: string;
  tokenTransfers: TokenTransfer[];
  nativeTransfers: NativeTransfer[];
  accountData: AccountData[];
  events?: Record<string, any>;
}

export interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

export interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

export interface AccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: TokenBalanceChange[];
}

export interface TokenBalanceChange {
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
  userAccount: string;
}

// ── API types ─────────────────────────────────────────────────

export interface ScoreRequest {
  wallet: string;
  forceRefresh?: boolean;
}

export interface ScoreResponse {
  success: boolean;
  data?: RepScore;
  error?: string;
  fromCache?: boolean;
}

export interface BatchScoreRequest {
  wallets: string[];
  forceRefresh?: boolean;
}

export interface BatchScoreResponse {
  success: boolean;
  results: Record<string, ScoreResponse>;
  errors: Record<string, string>;
}
