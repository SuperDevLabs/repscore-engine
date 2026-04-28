// ============================================================
// RepScore Engine — Core Types
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
  graduatedCount: number;       // bonded to Raydium
  avgLongevityHours: number;    // pump.fun reality — hours not days
  avgHolderRetention7d: number;
  avgHolderRetention30d: number;
  walletAgeDays: number;
  totalVolumeSol: number;
  lastActivityAt: string;
}

// ── Raw on-chain data structures ──────────────────────────────

export interface TokenLaunch {
  mint: string;
  deployer: string;
  deployedAt: number;             // unix timestamp

  // Longevity — pump.fun tiered milestones
  lastActivityAt: number;         // unix timestamp of last meaningful tx
  survivedHours: number;          // how long the token stayed alive
  graduated: boolean;             // bonded to Raydium

  // Dev wallet behavior
  devAllocationPct: number;       // % of supply held at launch
  devFirstSellHours: number | null; // hours after launch before first dev sell
  devSoldPct50InFirstHour: boolean; // dumped >50% in first hour
  selfSniped: boolean;            // dev wallet bought with bot pre-launch

  // Post-graduation LP (Raydium only — pump.fun LP is protocol-controlled)
  postGradLpPulled: boolean;
  postGradLpPulledHours: number | null; // hours after graduation

  // Holders
  peakHolders: number;
  holders7d: number;
  holders30d: number;
  holders90d: number;

  // On-chain hygiene
  mintRenounced: boolean;
  freezeAuthorityRevoked: boolean;
  telegramDeleted: boolean;
}

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
