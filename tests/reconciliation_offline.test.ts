import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import {
  ReconciliationEngine,
  ReconciliationConfigurationError,
  verifyDatabaseReadOnlyRole,
  evaluateWalletValues,
  evaluateActiveHolds,
  evaluateAllowanceAccounting,
  evaluateOrphanedUsage,
  evaluateQuarantinedReservations,
  evaluateStuckReservations,
  evaluateLegacyWallet,
  evaluatePlanAllocationAlignment,
} from "../src/scripts/reconcile_token_ledger.js";

describe("Phase 5 — Reconciliation Offline Unit Verification", () => {
  // 1. Safety Gate Verification
  test("Safety Gate: Rejects execution when readOnly is false", () => {
    const engine = new ReconciliationEngine({ readOnly: false });
    assert.throws(
      () => engine.assertReadOnlyMode(),
      (err: any) => {
        assert.ok(err instanceof ReconciliationConfigurationError);
        assert.ok(err.message.includes("Execution refused"));
        return true;
      }
    );
  });

  test("Safety Gate: Permits execution when readOnly is true", () => {
    const engine = new ReconciliationEngine({ readOnly: true });
    assert.doesNotThrow(() => engine.assertReadOnlyMode());
  });

  test("Role Verification: Gracefully handles disconnected database without throwing", async () => {
    const result = await verifyDatabaseReadOnlyRole();
    assert.equal(result.isVerifiedReadOnly, false);
    assert.deepEqual(result.userRoles, []);
    assert.ok(result.warning?.includes("No active database connection"));
  });

  // 2. Pure Rule Evaluators (REC-01 to REC-08)
  test("Rule REC-01: Detects negative wallet balance as CRITICAL", () => {
    const wallet: any = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      balance: -100,
      reservedTokens: 0,
      totalAllocated: 10000,
      totalUsed: 10100,
    };
    const findings = evaluateWalletValues(wallet);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "REC-01");
    assert.equal(findings[0].severity, "CRITICAL");
    assert.equal(findings[0].observedValues?.field, "balance");
  });

  test("Rule REC-01: Passes valid non-negative wallet counters", () => {
    const wallet: any = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      balance: 7000,
      reservedTokens: 3000,
      totalAllocated: 10000,
      totalUsed: 0,
    };
    const findings = evaluateWalletValues(wallet);
    assert.equal(findings.length, 0);
  });

  test("Rule REC-02: Flags active hold desynchronization when reservedTokens mismatch holds sum", () => {
    const userId = new Types.ObjectId().toString();
    const wallet: any = {
      _id: new Types.ObjectId(),
      userId,
      reservedTokens: 5000,
    };
    const now = new Date();
    // Expired lock to trigger confirmed persistent mismatch
    const reservations: any[] = [
      {
        _id: new Types.ObjectId(),
        userId,
        reservedTokens: 2000,
        status: "RESERVED",
        lockExpiresAt: new Date(now.getTime() - 60000),
      },
    ];
    const findings = evaluateActiveHolds(wallet, reservations, now);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "REC-02");
    assert.equal(findings[0].severity, "HIGH");
    assert.equal(findings[0].classification, "ACTIVE_HOLD_DESYNC_PHANTOM_HOLD");
    assert.equal(findings[0].observedValues?.walletReservedTokens, 5000);
    assert.equal(findings[0].expectedValues?.walletReservedTokens, 2000);
  });

  test("Rule REC-03: Flags allowance accounting invariant breach when committed exceeds totalAllocated", () => {
    const userId = new Types.ObjectId().toString();
    // Balance 9000 + reserved 2000 = 11000, which exceeds totalAllocated 10000
    const wallet: any = {
      _id: new Types.ObjectId(),
      userId,
      balance: 9000,
      reservedTokens: 2000,
      totalAllocated: 10000,
      totalUsed: 0,
    };
    const findings = evaluateAllowanceAccounting(wallet, true);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "REC-03");
    assert.equal(findings[0].severity, "MEDIUM");
    assert.equal(findings[0].classification, "BALANCE_EXCEEDS_PERIOD_ALLOWANCE");
    assert.equal(findings[0].observedValues?.excessTokens, 1000);
  });

  test("Rule REC-04: Flags orphaned usage records without valid conversation linkage", () => {
    const userId = new Types.ObjectId().toString();
    const missingConvId = new Types.ObjectId().toString();
    const validMsgId = new Types.ObjectId().toString();

    const usages: any[] = [
      {
        _id: new Types.ObjectId(),
        userId,
        conversationId: missingConvId,
        messageId: validMsgId,
        totalTokens: 500,
      },
    ];

    const existingConvIds = new Set<string>(); // missingConvId is NOT present
    const existingMsgIds = new Set<string>([validMsgId]);

    const findings = evaluateOrphanedUsage(usages, existingConvIds, existingMsgIds);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "REC-04");
    assert.equal(findings[0].severity, "LOW");
    assert.equal(findings[0].classification, "POTENTIAL_ORPHANED_USAGE_CONVERSATION");
  });

  test("Rule REC-05: Flags quarantined reservations requiring operator inspection", () => {
    const userId = new Types.ObjectId().toString();
    const reservations: any[] = [
      {
        _id: new Types.ObjectId(),
        userId,
        reservedTokens: 1500,
        status: "QUARANTINED",
      },
    ];
    const findings = evaluateQuarantinedReservations(reservations);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "REC-05");
    assert.equal(findings[0].severity, "HIGH");
    assert.equal(findings[0].classification, "QUARANTINED_RESERVATION");
  });

  test("Rule REC-06: Flags stuck reservations with expired locks", () => {
    const userId = new Types.ObjectId().toString();
    const now = new Date();
    const expiredTime = new Date(now.getTime() - 600000); // 10 minutes ago

    const reservations: any[] = [
      {
        _id: new Types.ObjectId(),
        userId,
        reservedTokens: 2000,
        status: "RESERVED",
        lockExpiresAt: expiredTime,
        version: 1,
      },
    ];

    const findings = evaluateStuckReservations(reservations, now);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "REC-06");
    assert.equal(findings[0].severity, "HIGH");
    assert.equal(findings[0].classification, "STUCK_EXPIRED_RESERVED");
  });

  test("Rule REC-07: Flags legacy wallet without any allocation records", () => {
    const userId = new Types.ObjectId().toString();
    const wallet: any = {
      _id: new Types.ObjectId(),
      userId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
    };

    const findings = evaluateLegacyWallet(wallet, false);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "REC-07");
    assert.equal(findings[0].severity, "INFO");
    assert.equal(findings[0].confidence, "EXPECTED_HISTORICAL_STATE");
  });

  test("Rule REC-08: Flags plan-allocation misalignment between subscription and wallet", () => {
    const userId = new Types.ObjectId().toString();
    const user = {
      _id: userId,
      plan: "free",
    };

    const activeSub: any = {
      _id: new Types.ObjectId(),
      userId,
      plan: "pro", // Active sub is Pro, but user plan is Free
      status: "active",
      tokensPerPeriod: 50000,
    };

    const latestAlloc: any = {
      _id: new Types.ObjectId(),
      userId,
      plan: "free",
    };

    const findings = evaluatePlanAllocationAlignment(user, activeSub, latestAlloc);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].ruleCode, "REC-08");
    assert.equal(findings[0].classification, "PLAN_SUBSCRIPTION_DESYNC_CANDIDATE");
    assert.equal(findings[1].ruleCode, "REC-08");
    assert.equal(findings[1].classification, "PENDING_PERIOD_ALLOCATION_CANDIDATE");
  });
});
