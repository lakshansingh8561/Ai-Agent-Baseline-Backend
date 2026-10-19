import "dotenv/config";
import test, { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import mongoose, { Types } from "mongoose";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/database/models/user/index.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import { TokenAllocation } from "../src/database/models/tokenAllocation/index.js";
import { TokenUsage } from "../src/database/models/tokenUsage/index.js";
import { Subscription } from "../src/database/models/subscription/index.js";
import { Conversation } from "../src/database/models/conversation/index.js";
import { Message } from "../src/database/models/message/index.js";
import {
  ReconciliationEngine,
  ReconciliationConfigurationError,
  runReconciliationDiagnostic,
  evaluateWalletValues,
  evaluateActiveHolds,
  evaluateAllowanceAccounting,
  evaluateOrphanedUsage,
  evaluateQuarantinedReservations,
  evaluateStuckReservations,
  evaluateLegacyWallet,
  evaluatePlanAllocationAlignment,
  type ReconciliationFinding,
} from "../src/scripts/reconcile_token_ledger.js";

describe("Phase 5 — Token Ledger Reconciliation Diagnostic Test Suite", () => {
  let isDbConnected = false;
  const testRunId = new Types.ObjectId().toString();
  const testReportsDir = path.resolve(process.cwd(), "test-reports-" + testRunId);

  before(async () => {
    try {
      await connectDatabase();
      isDbConnected = true;
    } catch (err) {
      console.warn("DB connection error in reconciliation tests:", err);
    }
  });

  after(async () => {
    if (fs.existsSync(testReportsDir)) {
      fs.rmSync(testReportsDir, { recursive: true, force: true });
    }
    if (isDbConnected) {
      await mongoose.disconnect();
    }
  });

  // ==========================================================================
  // Unit Tests: Pure Rule Evaluators
  // ==========================================================================

  describe("Rule REC-01: Invalid Wallet Values", () => {
    it("should return no findings for structurally valid non-negative wallet values", () => {
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        balance: 5000,
        reservedTokens: 1000,
        totalAllocated: 10000,
        totalUsed: 4000,
      };

      const findings = evaluateWalletValues(wallet as any);
      assert.equal(findings.length, 0);
    });

    it("should detect negative balance as CRITICAL confirmed violation", () => {
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        balance: -50,
        reservedTokens: 0,
        totalAllocated: 10000,
        totalUsed: 0,
      };

      const findings = evaluateWalletValues(wallet as any);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-01");
      assert.equal(findings[0].severity, "CRITICAL");
      assert.equal(findings[0].confidence, "CONFIRMED");
      assert.equal(findings[0].classification, "CORRUPTED_WALLET_VALUE");
      assert.equal(findings[0].observedValues?.field, "balance");
      assert.equal(findings[0].observedValues?.rawValue, "-50");
    });

    it("should detect NaN, Infinity, or non-numeric types", () => {
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        balance: Number.NaN,
        reservedTokens: Number.POSITIVE_INFINITY,
        totalAllocated: "invalid" as any,
        totalUsed: null as any,
      };

      const findings = evaluateWalletValues(wallet as any);
      assert.equal(findings.length, 4);
      for (const f of findings) {
        assert.equal(f.ruleCode, "REC-01");
        assert.equal(f.severity, "CRITICAL");
      }
    });
  });

  describe("Rule REC-02: Active Hold Desynchronization", () => {
    it("should return no findings when wallet.reservedTokens matches active holds sum", () => {
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        reservedTokens: 2500,
      };

      const activeReservations = [
        {
          _id: new Types.ObjectId(),
          reservedTokens: 1000,
          status: "RESERVED" as const,
        },
        {
          _id: new Types.ObjectId(),
          reservedTokens: 1500,
          status: "RECOVERING" as const,
        },
        // SETTLED and REFUNDED must be excluded from active hold sum
        {
          _id: new Types.ObjectId(),
          reservedTokens: 3000,
          status: "SETTLED" as const,
        },
        {
          _id: new Types.ObjectId(),
          reservedTokens: 500,
          status: "REFUNDED" as const,
        },
        {
          _id: new Types.ObjectId(),
          reservedTokens: 1200,
          status: "QUARANTINED" as const,
        },
      ];

      const findings = evaluateActiveHolds(wallet as any, activeReservations as any);
      assert.equal(findings.length, 0);
    });

    it("should report confirmed phantom hold when wallet has reservedTokens without any active reservations", () => {
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        reservedTokens: 1500,
      };

      const findings = evaluateActiveHolds(wallet as any, [], new Date());
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-02");
      assert.equal(findings[0].severity, "HIGH");
      assert.equal(findings[0].confidence, "CONFIRMED");
      assert.equal(findings[0].classification, "ACTIVE_HOLD_DESYNC_PHANTOM_HOLD");
      assert.equal(findings[0].observedValues?.walletReservedTokens, 1500);
      assert.equal(findings[0].observedValues?.activeReservationsHoldSum, 0);
    });

    it("should classify active hold discrepancy as INCONCLUSIVE when unexpired in-flight reservations exist", () => {
      const now = new Date("2026-01-01T12:00:00Z");
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        reservedTokens: 500, // Snapshot discrepancy during concurrent settlement
      };

      const activeReservations = [
        {
          _id: new Types.ObjectId(),
          reservedTokens: 2000,
          status: "RESERVED" as const,
          lockExpiresAt: new Date("2026-01-01T12:03:00Z"), // 3 minutes remaining on in-flight lease
        },
      ];

      const findings = evaluateActiveHolds(wallet as any, activeReservations as any, now);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-02");
      assert.equal(findings[0].severity, "MEDIUM");
      assert.equal(findings[0].confidence, "SUSPECTED");
      assert.equal(findings[0].classification, "INCONCLUSIVE_TRANSIENT_HOLD_DISCREPANCY");
      assert.ok(findings[0].explanation.includes("in-flight"));
    });

    it("should report confirmed under-reserved hold when all active reservations are expired", () => {
      const now = new Date("2026-01-01T12:00:00Z");
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        reservedTokens: 500,
      };

      const activeReservations = [
        {
          _id: new Types.ObjectId(),
          reservedTokens: 2000,
          status: "RESERVED" as const,
          lockExpiresAt: new Date("2026-01-01T11:55:00Z"), // Expired 5 minutes ago
        },
      ];

      const findings = evaluateActiveHolds(wallet as any, activeReservations as any, now);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-02");
      assert.equal(findings[0].severity, "HIGH");
      assert.equal(findings[0].confidence, "CONFIRMED");
      assert.equal(findings[0].classification, "ACTIVE_HOLD_DESYNC_UNDER_RESERVED");
      assert.equal(findings[0].observedValues?.discrepancyDelta, -1500);
    });
  });

  describe("Rule REC-03: Allowance and Accounting Anomalies", () => {
    it("should NOT flag legitimate low balances after usage as quota violations", () => {
      // User with 10k allowance has spent 9k, current balance is 1k, reserved is 0
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        balance: 1000,
        reservedTokens: 0,
        totalAllocated: 10000,
        totalUsed: 9000,
      };

      const findings = evaluateAllowanceAccounting(wallet as any, true);
      assert.equal(
        findings.length,
        0,
        "Legitimate consumed balance must NOT be flagged as anomaly"
      );
    });

    it("should detect balance + reservedTokens exceeding totalAllocated for allocated account", () => {
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        balance: 9000,
        reservedTokens: 2000, // 11000 total committed
        totalAllocated: 10000,
        totalUsed: 1000,
      };

      const findings = evaluateAllowanceAccounting(wallet as any, true);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-03");
      assert.equal(findings[0].classification, "BALANCE_EXCEEDS_PERIOD_ALLOWANCE");
      assert.equal(findings[0].observedValues?.committedTokens, 11000);
      assert.equal(findings[0].observedValues?.excessTokens, 1000);
    });

    it("should NOT flag legacy pre-allocation wallets under REC-03 without allocation records", () => {
      const legacyWallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        balance: 50000,
        reservedTokens: 0,
        totalAllocated: 10000, // Historical record where balance exceeds totalAllocated from legacy top-ups
        totalUsed: 0,
      };

      const findings = evaluateAllowanceAccounting(legacyWallet as any, false);
      assert.equal(
        findings.length,
        0,
        "Legacy pre-allocation wallets must not trigger false positive period quota violations"
      );
    });
  });

  describe("Rule REC-04: Orphaned Usage Links", () => {
    it("should not flag usage when conversation and message exist", () => {
      const convId = new Types.ObjectId().toString();
      const msgId = new Types.ObjectId().toString();

      const usage = [
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          conversationId: convId,
          messageId: msgId,
          totalTokens: 500,
        },
      ];

      const findings = evaluateOrphanedUsage(
        usage as any,
        new Set([convId]),
        new Set([msgId])
      );
      assert.equal(findings.length, 0);
    });

    it("should flag missing conversation as potential orphan with SUSPECTED confidence", () => {
      const convId = new Types.ObjectId().toString();
      const msgId = new Types.ObjectId().toString();

      const usage = [
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          conversationId: convId,
          messageId: msgId,
          totalTokens: 250,
        },
      ];

      const findings = evaluateOrphanedUsage(
        usage as any,
        new Set([]), // conversation missing
        new Set([msgId])
      );

      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-04");
      assert.equal(findings[0].severity, "LOW");
      assert.equal(findings[0].confidence, "SUSPECTED");
      assert.equal(findings[0].classification, "POTENTIAL_ORPHANED_USAGE_CONVERSATION");
      assert.equal(findings[0].conversationId, convId);
    });

    it("should flag missing message as potential orphan with SUSPECTED confidence", () => {
      const convId = new Types.ObjectId().toString();
      const msgId = new Types.ObjectId().toString();

      const usage = [
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          conversationId: convId,
          messageId: msgId,
          totalTokens: 300,
        },
      ];

      const findings = evaluateOrphanedUsage(
        usage as any,
        new Set([convId]),
        new Set([]) // message missing
      );

      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-04");
      assert.equal(findings[0].classification, "POTENTIAL_ORPHANED_USAGE_MESSAGE");
      assert.equal(findings[0].messageId, msgId);
    });
  });

  describe("Rule REC-05: Quarantined Reservations", () => {
    it("should report quarantined reservation with safe audit fields and no message content", () => {
      const resId = new Types.ObjectId();
      const uId = new Types.ObjectId();
      const cId = new Types.ObjectId();
      const mId = new Types.ObjectId();

      const quarantined = [
        {
          _id: resId,
          userId: uId,
          conversationId: cId,
          assistantMessageId: mId,
          reservedTokens: 1200,
          billedTokens: 0,
          usageVerification: "INVALID_METADATA_FALLBACK" as const,
          verificationNotes: "Corrupted provider usage payload",
          claimOwner: "sweeper-worker-99",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:05:00Z"),
        },
      ];

      const findings = evaluateQuarantinedReservations(quarantined as any);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-05");
      assert.equal(findings[0].severity, "HIGH");
      assert.equal(findings[0].confidence, "CONFIRMED");
      assert.equal(findings[0].classification, "QUARANTINED_RESERVATION");
      assert.equal(findings[0].reservationId, resId.toString());

      // Assert no message content is leaked
      assert.equal((findings[0] as any).content, undefined);
      assert.equal((findings[0] as any).prompt, undefined);
      assert.equal((findings[0].observedValues as any).messageContent, undefined);
    });
  });

  describe("Rule REC-06: Stuck Reservations & State-Specific Leases", () => {
    it("should detect expired RESERVED using lockExpiresAt", () => {
      const now = new Date("2026-01-01T12:00:00Z");
      const reservations = [
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          status: "RESERVED" as const,
          lockExpiresAt: new Date("2026-01-01T11:55:00Z"), // Expired 5 mins ago
          recoveryExpiresAt: null,
          version: 1,
        },
      ];

      const findings = evaluateStuckReservations(reservations as any, now);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-06");
      assert.equal(findings[0].classification, "STUCK_EXPIRED_RESERVED");
      assert.equal(findings[0].observedValues?.expiredByMs, 5 * 60 * 1000);
    });

    it("should detect expired RECOVERING using recoveryExpiresAt", () => {
      const now = new Date("2026-01-01T12:00:00Z");
      const reservations = [
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          status: "RECOVERING" as const,
          lockExpiresAt: new Date("2026-01-01T11:00:00Z"), // Original lock long past
          recoveryExpiresAt: new Date("2026-01-01T11:58:00Z"), // Recovery lease expired 2 mins ago
          claimOwner: "worker-1",
          version: 2,
        },
      ];

      const findings = evaluateStuckReservations(reservations as any, now);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-06");
      assert.equal(findings[0].classification, "STUCK_EXPIRED_RECOVERING");
      assert.equal(findings[0].observedValues?.claimOwner, "worker-1");
    });

    it("should NOT flag in-flight unexpired RESERVED or RECOVERING as stuck", () => {
      const now = new Date("2026-01-01T12:00:00Z");
      const reservations = [
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          status: "RESERVED" as const,
          lockExpiresAt: new Date("2026-01-01T12:05:00Z"), // 5 mins in future
          version: 1,
        },
        {
          _id: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          status: "RECOVERING" as const,
          lockExpiresAt: new Date("2026-01-01T11:00:00Z"),
          recoveryExpiresAt: new Date("2026-01-01T12:02:00Z"), // 2 mins in future
          version: 2,
        },
      ];

      const findings = evaluateStuckReservations(reservations as any, now);
      assert.equal(findings.length, 0, "Unexpired active leases must not be reported as stuck");
    });
  });

  describe("Rule REC-07: Legacy Pre-Allocation Wallets", () => {
    it("should identify legacy wallet with no allocation as EXPECTED_HISTORICAL_STATE and INFO", () => {
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        balance: 10000,
        totalAllocated: 10000,
        totalUsed: 500,
      };

      const findings = evaluateLegacyWallet(wallet as any, false);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-07");
      assert.equal(findings[0].severity, "INFO");
      assert.equal(findings[0].confidence, "EXPECTED_HISTORICAL_STATE");
      assert.equal(findings[0].classification, "LEGACY_PRE_ALLOCATION");
      assert.ok(findings[0].recommendedAction.includes("do NOT fabricate historical"));
    });

    it("should return no findings when wallet has associated TokenAllocation records", () => {
      const wallet = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        balance: 10000,
      };

      const findings = evaluateLegacyWallet(wallet as any, true);
      assert.equal(findings.length, 0);
    });
  });

  describe("Rule REC-08: Plan/Allocation Alignment", () => {
    it("should flag mismatch between user.plan and active subscription plan as candidate for review", () => {
      const user = { _id: new Types.ObjectId(), plan: "free" };
      const sub = {
        _id: new Types.ObjectId(),
        plan: "pro" as const,
        status: "active" as const,
      };
      const alloc = {
        _id: new Types.ObjectId(),
        plan: "pro" as const,
      };

      const findings = evaluatePlanAllocationAlignment(user, sub as any, alloc as any);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-08");
      assert.equal(findings[0].severity, "MEDIUM");
      assert.equal(findings[0].confidence, "SUSPECTED");
      assert.equal(findings[0].classification, "PLAN_SUBSCRIPTION_DESYNC_CANDIDATE");
    });

    it("should flag active paid subscription without corresponding allocation", () => {
      const user = { _id: new Types.ObjectId(), plan: "pro" };
      const sub = {
        _id: new Types.ObjectId(),
        plan: "pro" as const,
        status: "active" as const,
        currentPeriodStart: new Date(),
      };
      const alloc = {
        _id: new Types.ObjectId(),
        plan: "free" as const, // Allocation is for free, but sub is pro
      };

      const findings = evaluatePlanAllocationAlignment(user, sub as any, alloc as any);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].ruleCode, "REC-08");
      assert.equal(findings[0].classification, "PENDING_PERIOD_ALLOCATION_CANDIDATE");
    });
  });

  // ==========================================================================
  // Operational Safety, Configuration & Invariant Tests
  // ==========================================================================

  describe("Operational Safety & Configuration Gates", () => {
    it("should refuse execution and throw ReconciliationConfigurationError when read-only mode is not set", () => {
      assert.throws(
        () => {
          const engine = new ReconciliationEngine({ readOnly: false });
          engine.assertReadOnlyMode();
        },
        ReconciliationConfigurationError,
        "Engine must throw if readOnly is false"
      );
    });

    it("should allow execution when readOnly is explicitly true", () => {
      const engine = new ReconciliationEngine({ readOnly: true });
      assert.doesNotThrow(() => engine.assertReadOnlyMode());
    });

    it("should verify by static inspection that reconcile_token_ledger.ts contains NO database mutation calls", () => {
      const scriptPath = path.resolve(
        process.cwd(),
        "src/scripts/reconcile_token_ledger.ts"
      );
      const content = fs.readFileSync(scriptPath, "utf8");

      // Verify no write methods on Mongoose models are called
      const forbiddenCalls = [
        ".save(",
        ".updateOne(",
        ".updateMany(",
        ".deleteOne(",
        ".deleteMany(",
        ".insertMany(",
        ".findOneAndUpdate(",
        ".findOneAndDelete(",
        ".findOneAndReplace(",
        ".findByIdAndUpdate(",
        ".findByIdAndDelete(",
        ".createIndex(",
        ".dropIndex(",
        ".dropCollection(",
      ];

      for (const call of forbiddenCalls) {
        // Exclude comments or string literals explaining the safety rules
        const linesWithCall = content
          .split("\n")
          .filter((line) => line.includes(call) && !line.trim().startsWith("//") && !line.includes("forbidden"));
        assert.equal(
          linesWithCall.length,
          0,
          `Script must not invoke write operation ${call}. Found on line: ${linesWithCall[0]}`
        );
      }
    });
  });

  // ==========================================================================
  // Dry-Run Integration, JSONL Parsing, and Cursor Pagination
  // ==========================================================================

  describe("Dry Run Integration & Document Immutability", () => {
    let testUser1Id: Types.ObjectId;
    let testUser2Id: Types.ObjectId;
    let testUser3Id: Types.ObjectId;

    beforeEach(async () => {
      if (!isDbConnected) return;

      testUser1Id = new Types.ObjectId();
      testUser2Id = new Types.ObjectId();
      testUser3Id = new Types.ObjectId();

      // Seed 3 test users
      await User.create([
        {
          _id: testUser1Id,
          name: "Test User 1",
          email: `user1_${testRunId}@example.com`,
          passwordHash: "hash1",
          plan: "free",
        },
        {
          _id: testUser2Id,
          name: "Test User 2",
          email: `user2_${testRunId}@example.com`,
          passwordHash: "hash2",
          plan: "pro",
        },
        {
          _id: testUser3Id,
          name: "Test User 3",
          email: `user3_${testRunId}@example.com`,
          passwordHash: "hash3",
          plan: "free",
        },
      ]);

      // Seed wallet for User 1 (valid)
      await TokenWallet.create({
        userId: testUser1Id,
        balance: 10000,
        reservedTokens: 0,
        totalAllocated: 10000,
        totalUsed: 0,
        lastAllocatedPlan: "free",
      });

      // Seed wallet for User 2 (with an invalid negative value to trigger REC-01; use raw collection to bypass Mongoose client validation)
      await TokenWallet.collection.insertOne({
        userId: testUser2Id,
        balance: -100,
        reservedTokens: 0,
        totalAllocated: 50000,
        totalUsed: 0,
        lastAllocatedPlan: "pro",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    afterEach(async () => {
      if (!isDbConnected) return;
      await User.deleteMany({ _id: { $in: [testUser1Id, testUser2Id, testUser3Id] } });
      await TokenWallet.deleteMany({ userId: { $in: [testUser1Id, testUser2Id, testUser3Id] } });
    });

    it("should leave all database documents byte-for-byte unchanged after diagnostic dry-run", async () => {
      if (!isDbConnected) return;

      // 1. Snapshot database documents before run
      const user1Before = await User.findById(testUser1Id).lean();
      const user2Before = await User.findById(testUser2Id).lean();
      const wallet1Before = await TokenWallet.findOne({ userId: testUser1Id }).lean();
      const wallet2Before = await TokenWallet.findOne({ userId: testUser2Id }).lean();

      // 2. Execute reconciliation diagnostic in read-only mode targeted at User 1 & 2
      const reportFile = path.join(testReportsDir, "immutability-test.jsonl");
      await runReconciliationDiagnostic({
        readOnly: true,
        userId: testUser1Id.toString(),
        outFile: reportFile,
        silent: true,
      });

      await runReconciliationDiagnostic({
        readOnly: true,
        userId: testUser2Id.toString(),
        outFile: reportFile,
        silent: true,
      });

      // 3. Snapshot database documents after run
      const user1After = await User.findById(testUser1Id).lean();
      const user2After = await User.findById(testUser2Id).lean();
      const wallet1After = await TokenWallet.findOne({ userId: testUser1Id }).lean();
      const wallet2After = await TokenWallet.findOne({ userId: testUser2Id }).lean();

      // 4. Assert zero mutations occurred
      assert.deepEqual(user1After, user1Before, "User 1 document must not be mutated");
      assert.deepEqual(user2After, user2Before, "User 2 document must not be mutated");
      assert.deepEqual(wallet1After, wallet1Before, "Wallet 1 document must not be mutated");
      assert.deepEqual(wallet2After, wallet2Before, "Wallet 2 document must not be mutated");
    });

    it("should produce valid parseable JSONL report with required fields", async () => {
      if (!isDbConnected) return;

      const reportFile = path.join(testReportsDir, "schema-validation.jsonl");

      const result = await runReconciliationDiagnostic({
        readOnly: true,
        userId: testUser2Id.toString(), // Has negative balance (-100)
        outFile: reportFile,
        silent: true,
      });

      assert.ok(fs.existsSync(reportFile), "Report file must be created on disk");

      const fileStream = fs.createReadStream(reportFile);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      let lineCount = 0;
      for await (const line of rl) {
        if (!line.trim()) continue;
        lineCount++;
        const parsed = JSON.parse(line) as ReconciliationFinding;

        assert.ok(parsed.ruleCode, "Finding must have ruleCode");
        assert.ok(parsed.severity, "Finding must have severity");
        assert.ok(parsed.confidence, "Finding must have confidence");
        assert.ok(parsed.classification, "Finding must have classification");
        assert.ok(parsed.userId, "Finding must have userId");
        assert.ok(parsed.detectedAt, "Finding must have detectedAt");
        assert.ok(parsed.explanation, "Finding must have explanation");
        assert.ok(parsed.recommendedAction, "Finding must have recommendedAction");
      }

      assert.ok(lineCount > 0, "At least one finding should be written for corrupted user");
    });
  });

  describe("Deterministic Cursor Pagination", () => {
    let batchTestUserIds: Types.ObjectId[] = [];

    beforeEach(async () => {
      if (!isDbConnected) return;

      batchTestUserIds = [
        new Types.ObjectId(),
        new Types.ObjectId(),
        new Types.ObjectId(),
        new Types.ObjectId(),
        new Types.ObjectId(),
      ].sort((a, b) => (a.toString() < b.toString() ? -1 : 1));

      for (let i = 0; i < batchTestUserIds.length; i++) {
        await User.create({
          _id: batchTestUserIds[i],
          name: `Batch User ${i}`,
          email: `batch_${i}_${testRunId}@example.com`,
          passwordHash: "hash",
          plan: "free",
        });
      }
    });

    afterEach(async () => {
      if (!isDbConnected) return;
      await User.deleteMany({ _id: { $in: batchTestUserIds } });
    });

    it("should process each user in the batch test exactly once across boundary splits", async () => {
      if (!isDbConnected) return;

      const scannedUsers: string[] = [];

      // Create an engine with batchSize: 2 to force multiple pagination hops across the 5 users
      const engine = new ReconciliationEngine({
        readOnly: true,
        batchSize: 2,
        silent: true,
        outFile: path.join(testReportsDir, "pagination-test.jsonl"),
      });

      // Override auditUser to spy on visited IDs without modifying production logic
      const originalAudit = engine.auditUser.bind(engine);
      engine.auditUser = async (user: any) => {
        if (batchTestUserIds.some((id) => id.toString() === user._id.toString())) {
          scannedUsers.push(user._id.toString());
        }
        return await originalAudit(user);
      };

      await engine.execute();

      // Assert each test user was scanned exactly once
      assert.equal(scannedUsers.length, 5, "All 5 batch test users must be processed");
      const uniqueScanned = new Set(scannedUsers);
      assert.equal(uniqueScanned.size, 5, "No duplicate user processing across batch boundaries");
    });
  });
});
