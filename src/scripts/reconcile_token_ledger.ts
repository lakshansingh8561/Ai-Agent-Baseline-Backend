import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose, { Types } from "mongoose";
import { connectDatabase } from "../config/database.js";
import { TokenWallet, type ITokenWalletDocument } from "../database/models/tokenWallet/index.js";
import { TokenReservation, type ITokenReservationDocument } from "../database/models/tokenReservation/index.js";
import { TokenAllocation, type ITokenAllocationDocument } from "../database/models/tokenAllocation/index.js";
import { TokenUsage, type ITokenUsageDocument } from "../database/models/tokenUsage/index.js";
import { Subscription, type ISubscriptionDocument } from "../database/models/subscription/index.js";
import { User, type IUserDocument } from "../database/models/user/index.js";
import { Conversation } from "../database/models/conversation/index.js";
import { Message } from "../database/models/message/index.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type RuleCode =
  | "REC-01"
  | "REC-02"
  | "REC-03"
  | "REC-04"
  | "REC-05"
  | "REC-06"
  | "REC-07"
  | "REC-08";

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type FindingConfidence =
  | "CONFIRMED"
  | "SUSPECTED"
  | "EXPECTED_HISTORICAL_STATE";

export interface ReconciliationFinding {
  ruleCode: RuleCode;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  classification: string;
  userId: string;
  walletId?: string;
  reservationId?: string;
  usageId?: string;
  allocationId?: string;
  subscriptionId?: string;
  conversationId?: string;
  messageId?: string;
  observedValues?: Record<string, any>;
  expectedValues?: Record<string, any>;
  comparisonFormula?: string;
  detectedAt: string;
  explanation: string;
  recommendedAction: string;
}

export interface ReconciliationSummary {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  totalUsersScanned: number;
  totalWalletsScanned: number;
  totalReservationsScanned: number;
  totalUsagesScanned: number;
  totalFindings: number;
  findingsByRule: Record<RuleCode, number>;
  findingsBySeverity: Record<FindingSeverity, number>;
  skippedRecords: number;
  executionErrors: number;
  readOnlyEnforced: boolean;
  dbUserRoles?: string[];
  dbVerifiedReadOnly?: boolean;
  reportPath: string;
}

export interface ReconciliationOptions {
  readOnly?: boolean;
  batchSize?: number;
  outDir?: string;
  outFile?: string;
  userId?: string;
  failOnCritical?: boolean;
  failOnFindings?: boolean;
  silent?: boolean;
  now?: Date;
}

export class ReconciliationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationConfigurationError";
  }
}

// ============================================================================
// Database Security & Role Verification
// ============================================================================

export const verifyDatabaseReadOnlyRole = async (): Promise<{
  isVerifiedReadOnly: boolean;
  userRoles: string[];
  warning?: string;
}> => {
  try {
    const adminDb = mongoose.connection.db;
    if (!adminDb) {
      return { isVerifiedReadOnly: false, userRoles: [], warning: "No active database connection" };
    }
    const status = await adminDb.command({ connectionStatus: 1 });
    const roles: Array<{ role: string; db: string }> = status?.authInfo?.authenticatedUserRoles || [];
    const roleNames = roles.map((r) => `${r.role}@${r.db}`);

    const hasWriteRole = roles.some((r) =>
      ["readWrite", "dbAdmin", "dbOwner", "root", "readWriteAnyDatabase"].includes(r.role)
    );

    const isReadOnly =
      roles.length > 0 &&
      !hasWriteRole &&
      roles.every((r) => ["read", "readAnyDatabase"].includes(r.role));

    return {
      isVerifiedReadOnly: isReadOnly,
      userRoles: roleNames,
      warning: hasWriteRole
        ? `Database user possesses write-capable role (${roleNames.join(", ")}). Read-only database user is recommended for staging/production audits.`
        : undefined,
    };
  } catch (err: any) {
    return {
      isVerifiedReadOnly: false,
      userRoles: [],
      warning: `Could not verify database role via connectionStatus: ${err?.message || String(err)}`,
    };
  }
};

// ============================================================================
// Pure Rule Evaluators (Functional, Isolated, Fully Unit-Testable)
// ============================================================================

/**
 * REC-01: Invalid wallet values
 * Detects negative, NaN, null, non-numeric, or non-finite values in wallet counters.
 */
export const evaluateWalletValues = (
  wallet: Partial<ITokenWalletDocument> | null | undefined,
  userId?: string
): ReconciliationFinding[] => {
  if (!wallet) return [];

  const findings: ReconciliationFinding[] = [];
  const uId = userId || wallet.userId?.toString() || "unknown";
  const nowIso = new Date().toISOString();

  const numericFields: Array<keyof Pick<ITokenWalletDocument, "balance" | "reservedTokens" | "totalAllocated" | "totalUsed">> = [
    "balance",
    "reservedTokens",
    "totalAllocated",
    "totalUsed",
  ];

  for (const field of numericFields) {
    const value = wallet[field];
    const isInvalid =
      value === undefined ||
      value === null ||
      typeof value !== "number" ||
      Number.isNaN(value) ||
      !Number.isFinite(value) ||
      value < 0;

    if (isInvalid) {
      findings.push({
        ruleCode: "REC-01",
        severity: "CRITICAL",
        confidence: "CONFIRMED",
        classification: "CORRUPTED_WALLET_VALUE",
        userId: uId,
        walletId: wallet._id?.toString(),
        observedValues: {
          field,
          rawType: typeof value,
          rawValue: String(value),
        },
        expectedValues: {
          field,
          condition: "Finite non-negative integer >= 0",
        },
        comparisonFormula: "typeof value === 'number' && Number.isFinite(value) && value >= 0",
        detectedAt: nowIso,
        explanation: `Wallet field '${field}' contains invalid or negative numeric value: ${String(value)}`,
        recommendedAction:
          "Immediate operator intervention required. Freeze wallet mutation; reconcile ledger history to reconstruct valid state. Do not perform automated balance mutations.",
      });
    }
  }

  return findings;
};

/**
 * REC-02: Active hold desynchronization
 * Compares wallet.reservedTokens with sum of outstanding holds from reservations in RESERVED and RECOVERING states.
 * Fenced against transient snapshot discrepancies by inspecting whether unexpired in-flight leases exist.
 */
export const evaluateActiveHolds = (
  wallet: Partial<ITokenWalletDocument> | null | undefined,
  activeReservations: Array<Pick<ITokenReservationDocument, "_id" | "reservedTokens" | "status" | "lockExpiresAt" | "recoveryExpiresAt">>,
  now: Date = new Date()
): ReconciliationFinding[] => {
  if (!wallet) return [];

  const findings: ReconciliationFinding[] = [];
  const uId = wallet.userId?.toString() || "unknown";
  const nowIso = now.toISOString();

  const reservedTokensInWallet = wallet.reservedTokens ?? 0;

  // Filter only active hold states: RESERVED and RECOVERING
  const relevantHolds = activeReservations.filter((r) =>
    r.status === "RESERVED" || r.status === "RECOVERING"
  );

  const activeHoldSum = relevantHolds.reduce(
    (sum, r) => sum + (typeof r.reservedTokens === "number" ? r.reservedTokens : 0),
    0
  );

  if (reservedTokensInWallet !== activeHoldSum) {
    // Check if any reservation in the active set is currently in-flight with an unexpired lease
    const hasActiveInFlightLease = relevantHolds.some((r) => {
      if (r.status === "RESERVED" && r.lockExpiresAt) {
        return new Date(r.lockExpiresAt).getTime() > now.getTime();
      }
      if (r.status === "RECOVERING" && r.recoveryExpiresAt) {
        return new Date(r.recoveryExpiresAt).getTime() > now.getTime();
      }
      return false;
    });

    const isPhantomHold = reservedTokensInWallet > activeHoldSum;

    if (hasActiveInFlightLease) {
      // Discrepancy coincides with active unexpired in-flight generations; classify as inconclusive
      findings.push({
        ruleCode: "REC-02",
        severity: "MEDIUM",
        confidence: "SUSPECTED",
        classification: "INCONCLUSIVE_TRANSIENT_HOLD_DISCREPANCY",
        userId: uId,
        walletId: wallet._id?.toString(),
        observedValues: {
          walletReservedTokens: reservedTokensInWallet,
          activeReservationsHoldSum: activeHoldSum,
          discrepancyDelta: reservedTokensInWallet - activeHoldSum,
          activeReservationsCount: relevantHolds.length,
          hasActiveInFlightLease: true,
        },
        expectedValues: {
          walletReservedTokens: activeHoldSum,
        },
        comparisonFormula: "wallet.reservedTokens === sum(activeReservations[status IN ('RESERVED','RECOVERING')].reservedTokens)",
        detectedAt: nowIso,
        explanation:
          "Hold discrepancy detected while an unexpired in-flight reservation lease is active. This may be a transient snapshot race during concurrent execution.",
        recommendedAction:
          "Do not adjust wallet balance. Re-run diagnostic after all in-flight generations conclude (settled or refunded) to determine if discrepancy persists.",
      });
    } else {
      // Confirmed persistent mismatch (all active holds are expired, or hold exists with zero active reservations)
      findings.push({
        ruleCode: "REC-02",
        severity: "HIGH",
        confidence: "CONFIRMED",
        classification: isPhantomHold
          ? "ACTIVE_HOLD_DESYNC_PHANTOM_HOLD"
          : "ACTIVE_HOLD_DESYNC_UNDER_RESERVED",
        userId: uId,
        walletId: wallet._id?.toString(),
        observedValues: {
          walletReservedTokens: reservedTokensInWallet,
          activeReservationsHoldSum: activeHoldSum,
          discrepancyDelta: reservedTokensInWallet - activeHoldSum,
          activeReservationsCount: relevantHolds.length,
          reservationIds: relevantHolds.map((r) => r._id?.toString()),
        },
        expectedValues: {
          walletReservedTokens: activeHoldSum,
        },
        comparisonFormula: "wallet.reservedTokens === sum(activeReservations[status IN ('RESERVED','RECOVERING')].reservedTokens)",
        detectedAt: nowIso,
        explanation: isPhantomHold
          ? `Wallet reservedTokens (${reservedTokensInWallet}) exceeds active hold sum (${activeHoldSum}). Unreleased phantom hold confirmed.`
          : `Active reservations hold sum (${activeHoldSum}) exceeds wallet reservedTokens (${reservedTokensInWallet}). Wallet is under-reserved.`,
        recommendedAction:
          "Operator review required. Inspect reservation settlement logs and Phase 4 sweeper telemetry. Do not adjust wallet balances automatically without operator authorization.",
      });
    }
  }

  return findings;
};

/**
 * REC-03: Allowance and accounting anomalies
 * Supported Invariant: For canonical accounts with active allocation grants (hasAllocation: true),
 * the total committed tokens (balance + reservedTokens) cannot exceed totalAllocated.
 * Legitimate low balances after token consumption are strictly VALID and MUST NOT be reported.
 * Entitlement is NEVER inferred from a plan name alone. Unallocated legacy wallets are excluded from this rule.
 */
export const evaluateAllowanceAccounting = (
  wallet: Partial<ITokenWalletDocument> | null | undefined,
  hasAllocation: boolean = true
): ReconciliationFinding[] => {
  if (!wallet) return [];

  // Exclude legacy pre-allocation wallets: historical accounts predate single-period allocation semantics (handled under REC-07)
  if (!hasAllocation) return [];

  const findings: ReconciliationFinding[] = [];
  const uId = wallet.userId?.toString() || "unknown";
  const nowIso = new Date().toISOString();

  const balance = wallet.balance ?? 0;
  const reserved = wallet.reservedTokens ?? 0;
  const totalAllocated = wallet.totalAllocated ?? 0;
  const committedTokens = balance + reserved;

  // Supported Invariant: Committed tokens must not exceed the current period allowance when totalAllocated > 0
  if (totalAllocated > 0 && committedTokens > totalAllocated) {
    findings.push({
      ruleCode: "REC-03",
      severity: "MEDIUM",
      confidence: "CONFIRMED",
      classification: "BALANCE_EXCEEDS_PERIOD_ALLOWANCE",
      userId: uId,
      walletId: wallet._id?.toString(),
      observedValues: {
        balance,
        reservedTokens: reserved,
        committedTokens,
        totalAllocated,
        excessTokens: committedTokens - totalAllocated,
      },
      expectedValues: {
        maxCommittedTokens: totalAllocated,
      },
      comparisonFormula: "balance + reservedTokens <= totalAllocated",
      detectedAt: nowIso,
      explanation: `Committed tokens (balance: ${balance} + reserved: ${reserved} = ${committedTokens}) exceeds total period allocation (${totalAllocated}).`,
      recommendedAction:
        "Audit recent TokenAllocation records and billing event history for over-crediting. Do not reduce wallet balance without verified accounting audit.",
    });
  }

  return findings;
};

/**
 * REC-04: Orphaned usage links
 * Identifies TokenUsage records whose referenced conversation or message cannot be found.
 * Classified as SUSPECTED because retention policies or user conversation deletion may explain missing records.
 */
export const evaluateOrphanedUsage = (
  usageRecords: Array<Pick<ITokenUsageDocument, "_id" | "userId" | "conversationId" | "messageId" | "totalTokens">>,
  existingConversationIds: Set<string>,
  existingMessageIds: Set<string>
): ReconciliationFinding[] => {
  const findings: ReconciliationFinding[] = [];
  const nowIso = new Date().toISOString();

  for (const usage of usageRecords) {
    const uId = usage.userId?.toString() || "unknown";

    if (usage.conversationId) {
      const convIdStr = usage.conversationId.toString();
      if (!existingConversationIds.has(convIdStr)) {
        findings.push({
          ruleCode: "REC-04",
          severity: "LOW",
          confidence: "SUSPECTED",
          classification: "POTENTIAL_ORPHANED_USAGE_CONVERSATION",
          userId: uId,
          usageId: usage._id?.toString(),
          conversationId: convIdStr,
          observedValues: {
            usageId: usage._id?.toString(),
            conversationId: convIdStr,
            totalTokens: usage.totalTokens,
          },
          expectedValues: {
            conversationExists: true,
          },
          comparisonFormula: "Conversation.exists({ _id: usage.conversationId }) === true",
          detectedAt: nowIso,
          explanation: `TokenUsage ${usage._id} references conversationId ${convIdStr} which was not found in Conversation collection. Retention policy or user conversation deletion may explain missing record.`,
          recommendedAction:
            "Verify data retention and deletion policies. Preserved usage is an immutable financial record and must NOT be purged or altered.",
        });
      }
    }

    if (usage.messageId) {
      const msgIdStr = usage.messageId.toString();
      if (!existingMessageIds.has(msgIdStr)) {
        findings.push({
          ruleCode: "REC-04",
          severity: "LOW",
          confidence: "SUSPECTED",
          classification: "POTENTIAL_ORPHANED_USAGE_MESSAGE",
          userId: uId,
          usageId: usage._id?.toString(),
          messageId: msgIdStr,
          observedValues: {
            usageId: usage._id?.toString(),
            messageId: msgIdStr,
            totalTokens: usage.totalTokens,
          },
          expectedValues: {
            messageExists: true,
          },
          comparisonFormula: "Message.exists({ _id: usage.messageId }) === true",
          detectedAt: nowIso,
          explanation: `TokenUsage ${usage._id} references messageId ${msgIdStr} which was not found in Message collection. Soft deletion or message purge may explain missing record.`,
          recommendedAction:
            "Verify message retention policies. Preserved usage is an immutable financial record and must NOT be purged or altered.",
        });
      }
    }
  }

  return findings;
};

/**
 * REC-05: Quarantined reservations
 * Reports reservations in QUARANTINED status.
 * Never exposes message content, prompts, or provider credentials.
 */
export const evaluateQuarantinedReservations = (
  quarantinedReservations: Array<Pick<ITokenReservationDocument, "_id" | "userId" | "conversationId" | "assistantMessageId" | "reservedTokens" | "billedTokens" | "usageVerification" | "verificationNotes" | "claimOwner" | "createdAt" | "updatedAt">>
): ReconciliationFinding[] => {
  const findings: ReconciliationFinding[] = [];
  const nowIso = new Date().toISOString();

  for (const res of quarantinedReservations) {
    const uId = res.userId?.toString() || "unknown";

    findings.push({
      ruleCode: "REC-05",
      severity: "HIGH",
      confidence: "CONFIRMED",
      classification: "QUARANTINED_RESERVATION",
      userId: uId,
      reservationId: res._id?.toString(),
      conversationId: res.conversationId?.toString(),
      messageId: res.assistantMessageId?.toString(),
      observedValues: {
        reservationId: res._id?.toString(),
        status: "QUARANTINED",
        reservedTokens: res.reservedTokens,
        billedTokens: res.billedTokens ?? null,
        usageVerification: res.usageVerification ?? null,
        verificationNotes: res.verificationNotes ?? null,
        claimOwner: res.claimOwner ?? null,
        createdAt: res.createdAt ? new Date(res.createdAt).toISOString() : null,
        updatedAt: res.updatedAt ? new Date(res.updatedAt).toISOString() : null,
      },
      expectedValues: {
        status: "SETTLED | REFUNDED",
      },
      comparisonFormula: "status !== 'QUARANTINED'",
      detectedAt: nowIso,
      explanation: `Reservation ${res._id} is in QUARANTINED status due to recovery failure or unresolvable transaction state. Notes: ${res.verificationNotes || "none"}`,
      recommendedAction:
        "Operator investigation required. Review verification notes and error context. Any compensating adjustment or ledger write requires explicit operator authorization.",
    });
  }

  return findings;
};

/**
 * REC-06: Stuck reservations
 * Detects expired RESERVED and RECOVERING records using state-specific lease fields:
 * - RESERVED: lockExpiresAt <= now
 * - RECOVERING: recoveryExpiresAt <= now (or recoveryExpiresAt is null/missing)
 * Merely being old does NOT make a reservation stuck (e.g. SETTLED/REFUNDED or future leases).
 */
export const evaluateStuckReservations = (
  activeReservations: Array<Pick<ITokenReservationDocument, "_id" | "userId" | "status" | "lockExpiresAt" | "recoveryExpiresAt" | "claimOwner" | "version">>,
  now: Date = new Date()
): ReconciliationFinding[] => {
  const findings: ReconciliationFinding[] = [];
  const nowIso = now.toISOString();

  for (const res of activeReservations) {
    const uId = res.userId?.toString() || "unknown";

    if (res.status === "RESERVED" && res.lockExpiresAt && new Date(res.lockExpiresAt).getTime() <= now.getTime()) {
      const lockExpTime = new Date(res.lockExpiresAt).getTime();
      findings.push({
        ruleCode: "REC-06",
        severity: "HIGH",
        confidence: "CONFIRMED",
        classification: "STUCK_EXPIRED_RESERVED",
        userId: uId,
        reservationId: res._id?.toString(),
        observedValues: {
          reservationId: res._id?.toString(),
          status: "RESERVED",
          lockExpiresAt: new Date(res.lockExpiresAt).toISOString(),
          now: nowIso,
          expiredByMs: now.getTime() - lockExpTime,
          version: res.version,
        },
        expectedValues: {
          lockExpiresAt: `> ${nowIso}`,
        },
        comparisonFormula: "status === 'RESERVED' && lockExpiresAt <= now",
        detectedAt: nowIso,
        explanation: `Reservation ${res._id} is stuck in RESERVED status beyond lock expiry (${new Date(res.lockExpiresAt).toISOString()}). Sweeper has not claimed or recovered this record.`,
        recommendedAction:
          "Verify background sweeper health (TokenSweeper service) or trigger an on-demand recovery sweep through canonical recovery service. Do not directly update reservation status in database.",
      });
    } else if (res.status === "RECOVERING") {
      const recExpTime = res.recoveryExpiresAt ? new Date(res.recoveryExpiresAt).getTime() : 0;
      if (recExpTime <= now.getTime()) {
        findings.push({
          ruleCode: "REC-06",
          severity: "HIGH",
          confidence: "CONFIRMED",
          classification: "STUCK_EXPIRED_RECOVERING",
          userId: uId,
          reservationId: res._id?.toString(),
          observedValues: {
            reservationId: res._id?.toString(),
            status: "RECOVERING",
            recoveryExpiresAt: res.recoveryExpiresAt ? new Date(res.recoveryExpiresAt).toISOString() : null,
            claimOwner: res.claimOwner ?? null,
            now: nowIso,
            expiredByMs: recExpTime > 0 ? now.getTime() - recExpTime : null,
            version: res.version,
          },
          expectedValues: {
            recoveryExpiresAt: `> ${nowIso}`,
          },
          comparisonFormula: "status === 'RECOVERING' && (!recoveryExpiresAt || recoveryExpiresAt <= now)",
          detectedAt: nowIso,
          explanation: `Reservation ${res._id} is stuck in RECOVERING status past worker recovery lease expiry (${res.recoveryExpiresAt ? new Date(res.recoveryExpiresAt).toISOString() : "null"}). Worker ${res.claimOwner || "unknown"} abandoned or timed out.`,
          recommendedAction:
            "Inspect claimOwner and trigger worker lease reclaim with canonical recovery service. Do not directly mutate database documents.",
        });
      }
    }
  }

  return findings;
};

/**
 * REC-07: Legacy pre-allocation wallets
 * Identifies wallets where no corresponding TokenAllocation records exist.
 * Classified as EXPECTED_HISTORICAL_STATE / INFO. Zero automatic mutation.
 */
export const evaluateLegacyWallet = (
  wallet: Partial<ITokenWalletDocument> | null | undefined,
  hasAllocation: boolean
): ReconciliationFinding[] => {
  if (!wallet) return [];

  const findings: ReconciliationFinding[] = [];
  const uId = wallet.userId?.toString() || "unknown";
  const nowIso = new Date().toISOString();

  if (!hasAllocation) {
    findings.push({
      ruleCode: "REC-07",
      severity: "INFO",
      confidence: "EXPECTED_HISTORICAL_STATE",
      classification: "LEGACY_PRE_ALLOCATION",
      userId: uId,
      walletId: wallet._id?.toString(),
      observedValues: {
        walletBalance: wallet.balance,
        totalAllocated: wallet.totalAllocated,
        totalUsed: wallet.totalUsed,
        hasAllocationRecord: false,
      },
      expectedValues: {
        hasAllocationRecord: true,
      },
      comparisonFormula: "TokenAllocation.exists({ userId }) === true",
      detectedAt: nowIso,
      explanation:
        "Wallet was initialized prior to the Phase 5 TokenAllocation ledger architecture. No allocation record exists for this user.",
      recommendedAction:
        "No automatic correction required. Preserve current wallet balance; do NOT fabricate historical TokenAllocation records.",
    });
  }

  return findings;
};

/**
 * REC-08: Plan/allocation alignment
 * Compares user plan, active subscription, and latest allocation records.
 * Candidates for review are reported with SUSPECTED confidence.
 */
export const evaluatePlanAllocationAlignment = (
  user: { _id: any; plan: string },
  activeSubscription: Partial<ISubscriptionDocument> | null | undefined,
  latestAllocation: Partial<ITokenAllocationDocument> | null | undefined
): ReconciliationFinding[] => {
  const findings: ReconciliationFinding[] = [];
  const uId = user._id?.toString() || "unknown";
  const nowIso = new Date().toISOString();

  // Condition 1: User plan vs Active Subscription plan mismatch
  if (activeSubscription && activeSubscription.status === "active") {
    if (user.plan !== activeSubscription.plan) {
      findings.push({
        ruleCode: "REC-08",
        severity: "MEDIUM",
        confidence: "SUSPECTED",
        classification: "PLAN_SUBSCRIPTION_DESYNC_CANDIDATE",
        userId: uId,
        subscriptionId: activeSubscription._id?.toString(),
        observedValues: {
          userPlan: user.plan,
          activeSubscriptionPlan: activeSubscription.plan,
          subscriptionStatus: activeSubscription.status,
        },
        expectedValues: {
          userPlan: activeSubscription.plan,
        },
        comparisonFormula: "User.plan === activeSubscription.plan",
        detectedAt: nowIso,
        explanation: `User plan ('${user.plan}') is out of sync with active subscription plan ('${activeSubscription.plan}').`,
        recommendedAction:
          "Review user subscription sync flow. Reconcile User.plan with active subscription through canonical subscription service.",
      });
    }

    // Condition 2: Active paid subscription has no corresponding allocation for its current plan
    if (activeSubscription.plan !== "free") {
      if (!latestAllocation || latestAllocation.plan !== activeSubscription.plan) {
        findings.push({
          ruleCode: "REC-08",
          severity: "MEDIUM",
          confidence: "SUSPECTED",
          classification: "PENDING_PERIOD_ALLOCATION_CANDIDATE",
          userId: uId,
          subscriptionId: activeSubscription._id?.toString(),
          allocationId: latestAllocation?._id?.toString(),
          observedValues: {
            activeSubscriptionPlan: activeSubscription.plan,
            latestAllocationPlan: latestAllocation?.plan ?? null,
            subscriptionPeriodStart: activeSubscription.currentPeriodStart
              ? new Date(activeSubscription.currentPeriodStart).toISOString()
              : null,
          },
          expectedValues: {
            latestAllocationPlan: activeSubscription.plan,
          },
          comparisonFormula: "latestAllocation.plan === activeSubscription.plan",
          detectedAt: nowIso,
          explanation: `User has active ${activeSubscription.plan} subscription but latest TokenAllocation record is for '${latestAllocation?.plan ?? "none"}'.`,
          recommendedAction:
            "Verify Polar webhook delivery and subscription renewal event processing for this billing period. Any grant must be processed through canonical allocateTokensForPlan.",
        });
      }
    }
  }

  return findings;
};

// ============================================================================
// Reconciliation Engine (Deterministic Cursor Pagination & Read-Only Streamer)
// ============================================================================

export class ReconciliationEngine {
  private options: Required<ReconciliationOptions>;
  private summary: ReconciliationSummary;
  private readonly defaultOutDir: string;

  constructor(options: ReconciliationOptions = {}) {
    const defaultBatch = 100;
    this.defaultOutDir = path.resolve(process.cwd(), "reports");

    this.options = {
      readOnly: options.readOnly ?? (process.env.RECONCILIATION_READ_ONLY === "true" || process.argv.includes("--read-only")),
      batchSize: options.batchSize ?? defaultBatch,
      outDir: options.outDir ?? process.env.REPORTS_DIR ?? this.defaultOutDir,
      outFile: options.outFile ?? "",
      userId: options.userId ?? "",
      failOnCritical: options.failOnCritical ?? false,
      failOnFindings: options.failOnFindings ?? false,
      silent: options.silent ?? false,
      now: options.now ?? new Date(),
    };

    const initialReportPath = this.resolveReportPath();

    this.summary = {
      startedAt: new Date().toISOString(),
      completedAt: "",
      durationMs: 0,
      totalUsersScanned: 0,
      totalWalletsScanned: 0,
      totalReservationsScanned: 0,
      totalUsagesScanned: 0,
      totalFindings: 0,
      findingsByRule: {
        "REC-01": 0,
        "REC-02": 0,
        "REC-03": 0,
        "REC-04": 0,
        "REC-05": 0,
        "REC-06": 0,
        "REC-07": 0,
        "REC-08": 0,
      },
      findingsBySeverity: {
        CRITICAL: 0,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
        INFO: 0,
      },
      skippedRecords: 0,
      executionErrors: 0,
      readOnlyEnforced: this.options.readOnly,
      reportPath: initialReportPath,
    };
  }

  private resolveReportPath(): string {
    if (this.options.outFile) {
      return path.resolve(this.options.outFile);
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(this.options.outDir, `reconciliation-${timestamp}.jsonl`);
  }

  /**
   * Enforces strict read-only execution gate.
   * Throws ReconciliationConfigurationError if read-only mode is not explicitly enabled.
   */
  public assertReadOnlyMode(): void {
    if (!this.options.readOnly) {
      throw new ReconciliationConfigurationError(
        "Execution refused: ReconcileTokenLedger must be run in explicit read-only mode. Provide the --read-only flag or set RECONCILIATION_READ_ONLY=true."
      );
    }
  }

  /**
   * Appends a finding to the JSONL report stream and updates summary counters.
   */
  private emitFinding(finding: ReconciliationFinding, stream?: fs.WriteStream): void {
    this.summary.totalFindings++;
    this.summary.findingsByRule[finding.ruleCode] = (this.summary.findingsByRule[finding.ruleCode] || 0) + 1;
    this.summary.findingsBySeverity[finding.severity] = (this.summary.findingsBySeverity[finding.severity] || 0) + 1;

    const line = JSON.stringify(finding) + "\n";
    if (stream) {
      stream.write(line);
    }
  }

  /**
   * Runs the complete diagnostic over users with bounded cursor pagination.
   */
  public async execute(): Promise<{ summary: ReconciliationSummary; findings: ReconciliationFinding[] }> {
    const startTime = Date.now();
    this.assertReadOnlyMode();

    // Verify database role permissions if connected
    const roleCheck = await verifyDatabaseReadOnlyRole();
    this.summary.dbUserRoles = roleCheck.userRoles;
    this.summary.dbVerifiedReadOnly = roleCheck.isVerifiedReadOnly;
    if (roleCheck.warning && !this.options.silent) {
      console.warn(`[Reconciliation Security Notice] ${roleCheck.warning}`);
    }

    const reportPath = this.resolveReportPath();
    const reportDir = path.dirname(reportPath);
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const fileStream = fs.createWriteStream(reportPath, { flags: "w", encoding: "utf8" });
    const collectedFindings: ReconciliationFinding[] = [];

    if (!this.options.silent) {
      console.log(`[Reconciliation] Starting read-only audit...`);
      console.log(`[Reconciliation] Report destination: ${reportPath}`);
      console.log(`[Reconciliation] Batch size: ${this.options.batchSize}`);
    }

    try {
      if (this.options.userId) {
        // Targeted single-user audit
        if (!Types.ObjectId.isValid(this.options.userId)) {
          throw new ReconciliationConfigurationError(`Invalid userId format: ${this.options.userId}`);
        }
        const user = await User.findById(this.options.userId).read("secondaryPreferred").lean();
        if (user) {
          const findings = await this.auditUser(user);
          for (const f of findings) {
            this.emitFinding(f, fileStream);
            collectedFindings.push(f);
          }
        } else {
          this.summary.skippedRecords++;
        }
      } else {
        // Deterministic cursor pagination by _id: 1
        let lastId: Types.ObjectId | null = null;
        let hasMore = true;

        while (hasMore) {
          const userQuery: Record<string, any> = lastId ? { _id: { $gt: lastId } } : {};

          const users = await User.find(userQuery)
            .sort({ _id: 1 })
            .limit(this.options.batchSize)
            .select("_id plan name email isActive")
            .read("secondaryPreferred")
            .lean();

          if (users.length === 0) {
            hasMore = false;
            break;
          }

          for (const user of users) {
            try {
              const findings = await this.auditUser(user);
              for (const f of findings) {
                this.emitFinding(f, fileStream);
                collectedFindings.push(f);
              }
            } catch (userAuditErr) {
              this.summary.executionErrors++;
              console.error(`[Reconciliation] Error auditing user ${user._id}:`, userAuditErr);
            }
          }

          lastId = users[users.length - 1]._id as Types.ObjectId;
          if (users.length < this.options.batchSize) {
            hasMore = false;
          }
        }
      }
    } finally {
      fileStream.end();
      await new Promise((resolve) => fileStream.on("finish", resolve));
    }

    this.summary.completedAt = new Date().toISOString();
    this.summary.durationMs = Date.now() - startTime;
    this.summary.reportPath = reportPath;

    if (!this.options.silent) {
      this.printSummary();
    }

    return { summary: this.summary, findings: collectedFindings };
  }

  /**
   * Audits a single user against all 8 reconciliation rules.
   * STRICTLY READ-ONLY: uses read("secondaryPreferred") and lean() queries. Zero mutations.
   */
  public async auditUser(user: any): Promise<ReconciliationFinding[]> {
    this.summary.totalUsersScanned++;
    const userFindings: ReconciliationFinding[] = [];
    const userId = user._id;

    // 1. Fetch wallet
    const wallet = await TokenWallet.findOne({ userId })
      .read("secondaryPreferred")
      .lean();

    if (wallet) {
      this.summary.totalWalletsScanned++;
    }

    // 2. Fetch reservations (RESERVED, RECOVERING, QUARANTINED)
    const activeAndQuarantinedReservations = await TokenReservation.find({
      userId,
      status: { $in: ["RESERVED", "RECOVERING", "QUARANTINED"] },
    })
      .read("secondaryPreferred")
      .lean();

    this.summary.totalReservationsScanned += activeAndQuarantinedReservations.length;

    // 3. Fetch allocations
    const allocations = await TokenAllocation.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .read("secondaryPreferred")
      .lean();

    const hasAllocation = allocations.length > 0;
    const latestAllocation = allocations[0] || null;

    // 4. Fetch active subscription
    const activeSubscription = await Subscription.findOne({
      userId,
      status: "active",
    })
      .read("secondaryPreferred")
      .lean();

    // 5. Fetch usages (bounded batch to prevent unbounded memory consumption)
    const usages = await TokenUsage.find({ userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .read("secondaryPreferred")
      .lean();

    this.summary.totalUsagesScanned += usages.length;

    // 6. Pre-fetch linked conversations & messages for usage link validation
    const convIdsToVerify = Array.from(
      new Set(usages.map((u) => u.conversationId?.toString()).filter(Boolean))
    ) as string[];
    const msgIdsToVerify = Array.from(
      new Set(usages.map((u) => u.messageId?.toString()).filter(Boolean))
    ) as string[];

    let existingConvIdSet = new Set<string>();
    if (convIdsToVerify.length > 0) {
      const foundConvs = await Conversation.find({
        _id: { $in: convIdsToVerify },
      })
        .select("_id")
        .read("secondaryPreferred")
        .lean();
      existingConvIdSet = new Set(foundConvs.map((c) => c._id.toString()));
    }

    let existingMsgIdSet = new Set<string>();
    if (msgIdsToVerify.length > 0) {
      const foundMsgs = await Message.find({
        _id: { $in: msgIdsToVerify },
      })
        .select("_id")
        .read("secondaryPreferred")
        .lean();
      existingMsgIdSet = new Set(foundMsgs.map((m) => m._id.toString()));
    }

    // --- Execute Rule Evaluators ---

    // REC-01: Invalid wallet values
    if (wallet) {
      userFindings.push(...evaluateWalletValues(wallet));
    }

    // REC-02: Active hold desynchronization (with transient in-flight lease awareness)
    if (wallet) {
      userFindings.push(
        ...evaluateActiveHolds(wallet, activeAndQuarantinedReservations as any, this.options.now)
      );
    }

    // REC-03: Allowance and accounting anomalies (narrowed to canonical allocated accounts)
    if (wallet) {
      userFindings.push(...evaluateAllowanceAccounting(wallet, hasAllocation));
    }

    // REC-04: Orphaned usage links
    if (usages.length > 0) {
      userFindings.push(...evaluateOrphanedUsage(usages as any, existingConvIdSet, existingMsgIdSet));
    }

    // REC-05: Quarantined reservations
    const quarantinedOnly = activeAndQuarantinedReservations.filter((r) => r.status === "QUARANTINED");
    if (quarantinedOnly.length > 0) {
      userFindings.push(...evaluateQuarantinedReservations(quarantinedOnly as any));
    }

    // REC-06: Stuck reservations
    const inFlightOnly = activeAndQuarantinedReservations.filter(
      (r) => r.status === "RESERVED" || r.status === "RECOVERING"
    );
    if (inFlightOnly.length > 0) {
      userFindings.push(...evaluateStuckReservations(inFlightOnly as any, this.options.now));
    }

    // REC-07: Legacy pre-allocation wallets
    if (wallet) {
      userFindings.push(...evaluateLegacyWallet(wallet, hasAllocation));
    }

    // REC-08: Plan/allocation alignment
    userFindings.push(...evaluatePlanAllocationAlignment(user, activeSubscription, latestAllocation));

    return userFindings;
  }

  private printSummary(): void {
    console.log("\n============================================================");
    console.log("          NEXAMIND TOKEN LEDGER RECONCILIATION SUMMARY       ");
    console.log("============================================================");
    console.log(`Execution Duration:    ${this.summary.durationMs}ms`);
    console.log(`Read-Only Enforced:    ${this.summary.readOnlyEnforced}`);
    if (this.summary.dbUserRoles && this.summary.dbUserRoles.length > 0) {
      console.log(`DB User Roles:         ${this.summary.dbUserRoles.join(", ")}`);
      console.log(`DB Verified Read-Only: ${this.summary.dbVerifiedReadOnly ? "YES" : "NO (write roles detected)"}`);
    }
    console.log(`Users Scanned:         ${this.summary.totalUsersScanned}`);
    console.log(`Wallets Scanned:       ${this.summary.totalWalletsScanned}`);
    console.log(`Reservations Scanned:  ${this.summary.totalReservationsScanned}`);
    console.log(`Usages Scanned:        ${this.summary.totalUsagesScanned}`);
    console.log(`Execution Errors:      ${this.summary.executionErrors}`);
    console.log(`Skipped Records:       ${this.summary.skippedRecords}`);
    console.log(`Total Findings:        ${this.summary.totalFindings}`);
    console.log("------------------------------------------------------------");
    console.log("Findings by Severity:");
    for (const [sev, count] of Object.entries(this.summary.findingsBySeverity)) {
      console.log(`  - ${sev.padEnd(10)}: ${count}`);
    }
    console.log("Findings by Rule:");
    for (const [rule, count] of Object.entries(this.summary.findingsByRule)) {
      console.log(`  - ${rule.padEnd(10)}: ${count}`);
    }
    console.log("------------------------------------------------------------");
    console.log(`JSONL Report Path:     ${this.summary.reportPath}`);
    console.log("============================================================\n");
  }
}

/**
 * Top-level convenience wrapper for programmatic or test invocation.
 */
export const runReconciliationDiagnostic = async (
  options: ReconciliationOptions = {}
): Promise<{ summary: ReconciliationSummary; findings: ReconciliationFinding[] }> => {
  const engine = new ReconciliationEngine(options);
  return await engine.execute();
};

// ============================================================================
// CLI Entry Point
// ============================================================================

const parseCliArgs = (): ReconciliationOptions => {
  const args = process.argv.slice(2);
  const options: ReconciliationOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--read-only") {
      options.readOnly = true;
    } else if (arg === "--batch-size" && i + 1 < args.length) {
      options.batchSize = Number.parseInt(args[++i], 10);
    } else if (arg === "--out-dir" && i + 1 < args.length) {
      options.outDir = args[++i];
    } else if (arg === "--out-file" && i + 1 < args.length) {
      options.outFile = args[++i];
    } else if (arg === "--user-id" && i + 1 < args.length) {
      options.userId = args[++i];
    } else if (arg === "--fail-on-critical") {
      options.failOnCritical = true;
    } else if (arg === "--fail-on-findings") {
      options.failOnFindings = true;
    } else if (arg === "--silent") {
      options.silent = true;
    } else if (arg === "--help") {
      console.log(`
NexaMind Token Ledger Reconciliation Diagnostic (Read-Only)

Usage:
  npx tsx src/scripts/reconcile_token_ledger.ts [options]

Required:
  --read-only            Explicit confirmation of read-only mode (or RECONCILIATION_READ_ONLY=true)

Options:
  --batch-size <number>  Cursor batch size for User pagination (default: 100)
  --out-dir <path>       Directory to save JSONL report (default: ./reports)
  --out-file <path>      Explicit filepath for JSONL report
  --user-id <hex>        Single user ID to diagnose
  --fail-on-critical     Exit code 3 if CRITICAL findings exist
  --fail-on-findings     Exit code 3 if any findings exist
  --silent               Suppress console summary output
  --help                 Show this help message

Exit Codes:
  0 - Diagnostic completed cleanly (findings do not trigger failure unless flagged)
  1 - Unhandled execution or database error
  2 - Configuration error (e.g. read-only flag omitted)
  3 - Findings detected when --fail-on-critical or --fail-on-findings was specified
`);
      process.exit(0);
    }
  }

  return options;
};

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
};

if (isMainModule()) {
  (async () => {
    try {
      const options = parseCliArgs();

      // Check read-only configuration before attempting database connection
      if (!options.readOnly && process.env.RECONCILIATION_READ_ONLY !== "true") {
        console.error(
          "Error: ReconcileTokenLedger must be run in explicit read-only mode.\nPass --read-only or set RECONCILIATION_READ_ONLY=true."
        );
        process.exit(2);
      }

      await connectDatabase();

      const { summary } = await runReconciliationDiagnostic(options);

      await mongoose.disconnect();

      if (options.failOnFindings && summary.totalFindings > 0) {
        process.exit(3);
      }
      if (options.failOnCritical && (summary.findingsBySeverity.CRITICAL ?? 0) > 0) {
        process.exit(3);
      }

      process.exit(0);
    } catch (err: any) {
      if (err instanceof ReconciliationConfigurationError) {
        console.error(`[Reconciliation Configuration Error] ${err.message}`);
        process.exit(2);
      } else {
        console.error("[Reconciliation Fatal Error]", err);
        process.exit(1);
      }
    }
  })();
}
