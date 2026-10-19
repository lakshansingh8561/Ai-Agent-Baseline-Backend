import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import mongoose, { Types } from "mongoose";
import {
  createTokenReservation,
  allocateTokensForPlan,
  settleTokenReservation,
  refundTokenReservation,
} from "../src/features/token/token.service.js";
import {
  TokenWalletCorruptedError,
  TokenInvariantViolationError,
  TokenWalletNotFoundError,
} from "../src/features/token/token.errors.js";
import { TokenWallet } from "../src/database/models/tokenWallet/index.js";
import { TokenAllocation } from "../src/database/models/tokenAllocation/index.js";
import { TokenUsage } from "../src/database/models/tokenUsage/index.js";
import { TokenReservation } from "../src/database/models/tokenReservation/index.js";
import { User } from "../src/database/models/user/index.js";
import { Subscription } from "../src/database/models/subscription/index.js";
import {
  ReconciliationEngine,
  ReconciliationConfigurationError,
  evaluateWalletValues,
} from "../src/scripts/reconcile_token_ledger.js";

describe("Phase 5 — Wallet Safety & Missing-Wallet Regression Tests", () => {
  // Snapshot original static and prototype methods
  const originalMongooseStartSession = mongoose.startSession;
  const originalTokenWalletFindOne = TokenWallet.findOne;
  const originalTokenWalletCreate = TokenWallet.create;
  const originalTokenWalletFindOneAndUpdate = TokenWallet.findOneAndUpdate;
  const originalTokenWalletSave = TokenWallet.prototype.save;
  const originalTokenAllocationFindOne = TokenAllocation.findOne;
  const originalTokenAllocationExists = TokenAllocation.exists;
  const originalTokenAllocationCountDocuments = TokenAllocation.countDocuments;
  const originalTokenAllocationSave = TokenAllocation.prototype.save;
  const originalTokenUsageExists = TokenUsage.exists;
  const originalTokenReservationFindOneAndUpdate = TokenReservation.findOneAndUpdate;
  const originalTokenReservationExists = TokenReservation.exists;
  const originalTokenReservationCreate = TokenReservation.create;
  const originalUserFindById = User.findById;
  const originalSubscriptionFindOne = Subscription.findOne;

  // Fake session for transactional calls without real DB connection
  const createMockSession = () => {
    const session: any = {
      startTransaction: () => {},
      commitTransaction: async () => {},
      abortTransaction: async () => {},
      endSession: async () => {},
      withTransaction: async (fn: any) => await fn(session),
    };
    return session as unknown as mongoose.ClientSession;
  };

  // Chainable query mock that resolves both standalone and with .session(), .lean(), .select()
  const mockQuery = (val: any = null) => {
    const p: any = Promise.resolve(val);
    p.session = () => Promise.resolve(val);
    p.select = () => p;
    p.lean = () => Promise.resolve(val);
    p.read = () => p;
    return p;
  };

  beforeEach(() => {
    // Default safe offline mocks for instance save operations and session creation
    mongoose.startSession = (async () => createMockSession()) as any;
    TokenAllocation.prototype.save = (async function (this: any) {
      return this;
    }) as any;
    TokenWallet.prototype.save = (async function (this: any) {
      return this;
    }) as any;
  });

  afterEach(() => {
    // Restore all mocked statics and prototypes
    mongoose.startSession = originalMongooseStartSession;
    TokenWallet.findOne = originalTokenWalletFindOne;
    TokenWallet.create = originalTokenWalletCreate;
    TokenWallet.findOneAndUpdate = originalTokenWalletFindOneAndUpdate;
    TokenWallet.prototype.save = originalTokenWalletSave;
    TokenAllocation.findOne = originalTokenAllocationFindOne;
    TokenAllocation.exists = originalTokenAllocationExists;
    TokenAllocation.countDocuments = originalTokenAllocationCountDocuments;
    TokenAllocation.prototype.save = originalTokenAllocationSave;
    TokenUsage.exists = originalTokenUsageExists;
    TokenReservation.findOneAndUpdate = originalTokenReservationFindOneAndUpdate;
    TokenReservation.exists = originalTokenReservationExists;
    TokenReservation.create = originalTokenReservationCreate;
    User.findById = originalUserFindById;
    Subscription.findOne = originalSubscriptionFindOne;
  });

  // 1. Historical Usage
  test("1. Historical usage: A missing wallet with existing TokenUsage must not receive a fresh plan allowance", async () => {
    const userId = new Types.ObjectId();
    const mockSession = createMockSession();

    TokenWallet.findOne = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    User.findById = (() => ({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve({ _id: userId, plan: "free" }),
        }),
      }),
    })) as any;

    TokenAllocation.exists = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    // Existing historical usage
    TokenUsage.exists = (() => ({
      session: () => Promise.resolve({ _id: new Types.ObjectId() }),
    })) as any;

    TokenReservation.exists = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    let walletCreateCalled = false;
    TokenWallet.create = (() => {
      walletCreateCalled = true;
      return Promise.resolve([]);
    }) as any;

    await assert.rejects(
      async () => {
        await createTokenReservation(
          {
            userId,
            conversationId: new Types.ObjectId(),
            userMessageId: new Types.ObjectId(),
            assistantMessageId: new Types.ObjectId(),
            inputTokens: 100,
          },
          { session: mockSession }
        );
      },
      (err: any) => {
        assert.ok(err instanceof TokenWalletCorruptedError);
        assert.equal(err.statusCode, 503);
        assert.ok(err.message.includes("temporarily unavailable"));
        return true;
      }
    );

    assert.equal(walletCreateCalled, false, "TokenWallet.create must NOT be called for account with historical usage");
  });

  // 2. Historical Allocation
  test("2. Historical allocation: A missing wallet with an existing TokenAllocation must not receive a duplicate period grant", async () => {
    const userId = new Types.ObjectId();
    const mockSession = createMockSession();

    TokenWallet.findOne = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    User.findById = (() => ({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve({ _id: userId, plan: "free" }),
        }),
      }),
    })) as any;

    // Existing allocation record
    TokenAllocation.exists = (() => ({
      session: () => Promise.resolve({ _id: new Types.ObjectId() }),
    })) as any;

    TokenUsage.exists = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    TokenReservation.exists = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    let walletCreateCalled = false;
    TokenWallet.create = (() => {
      walletCreateCalled = true;
      return Promise.resolve([]);
    }) as any;

    await assert.rejects(
      async () => {
        await createTokenReservation(
          {
            userId,
            conversationId: new Types.ObjectId(),
            userMessageId: new Types.ObjectId(),
            assistantMessageId: new Types.ObjectId(),
            inputTokens: 100,
          },
          { session: mockSession }
        );
      },
      (err: any) => {
        assert.ok(err instanceof TokenWalletCorruptedError);
        assert.equal(err.statusCode, 503);
        return true;
      }
    );

    assert.equal(walletCreateCalled, false, "TokenWallet.create must NOT be called when allocation history exists");
  });

  // 3. Active Reservation (RESERVED)
  test("3. Active reservation: A missing wallet with a RESERVED reservation must fail safely and not reset reservedTokens to zero", async () => {
    const userId = new Types.ObjectId();
    const mockSession = createMockSession();

    TokenWallet.findOne = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    User.findById = (() => ({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve({ _id: userId, plan: "free" }),
        }),
      }),
    })) as any;

    TokenAllocation.exists = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    TokenUsage.exists = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    // Active reservation exists
    TokenReservation.exists = (() => ({
      session: () => Promise.resolve({ _id: new Types.ObjectId() }),
    })) as any;

    let walletCreatedTokens: any = null;
    TokenWallet.create = ((docs: any[]) => {
      walletCreatedTokens = docs[0];
      return Promise.resolve(docs);
    }) as any;

    await assert.rejects(
      async () => {
        await createTokenReservation(
          {
            userId,
            conversationId: new Types.ObjectId(),
            userMessageId: new Types.ObjectId(),
            assistantMessageId: new Types.ObjectId(),
            inputTokens: 100,
          },
          { session: mockSession }
        );
      },
      (err: any) => {
        assert.ok(err instanceof TokenWalletCorruptedError);
        assert.equal(err.statusCode, 503);
        return true;
      }
    );

    assert.equal(walletCreatedTokens, null, "Wallet must not be created with reservedTokens: 0");
  });

  // 4. Recovering Reservation (RECOVERING)
  test("4. Recovering reservation: A missing wallet with a RECOVERING reservation must fail safely and preserve reservation", async () => {
    const userId = new Types.ObjectId();
    const mockSession = createMockSession();

    TokenWallet.findOne = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    User.findById = (() => ({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve({ _id: userId, plan: "free" }),
        }),
      }),
    })) as any;

    TokenAllocation.exists = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    TokenUsage.exists = (() => ({
      session: () => Promise.resolve(null),
    })) as any;

    TokenReservation.exists = (() => ({
      session: () => Promise.resolve({ _id: new Types.ObjectId() }),
    })) as any;

    await assert.rejects(
      async () => {
        await createTokenReservation(
          {
            userId,
            conversationId: new Types.ObjectId(),
            userMessageId: new Types.ObjectId(),
            assistantMessageId: new Types.ObjectId(),
            inputTokens: 100,
          },
          { session: mockSession }
        );
      },
      (err: any) => {
        assert.ok(err instanceof TokenWalletCorruptedError);
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  });

  // 5. Settlement Safety
  test("5. Settlement safety: Missing wallet fails settlement and prevents corrupting assistant message as settled", async () => {
    const userId = new Types.ObjectId();
    const reservationId = new Types.ObjectId();
    const mockSession = createMockSession();

    TokenReservation.findOneAndUpdate = (() =>
      Promise.resolve({
        _id: reservationId,
        userId,
        reservedTokens: 2500,
        status: "SETTLED",
      })) as any;

    // Wallet is missing or has insufficient reservedTokens (e.g. 0)
    TokenWallet.findOneAndUpdate = (() => Promise.resolve(null)) as any;

    await assert.rejects(
      async () => {
        await settleTokenReservation(
          {
            reservationId,
            userId,
            assistantMessageId: new Types.ObjectId(),
            expectedVersion: 1,
            usageData: {
              billedTokens: 2000,
              billedInputTokens: 500,
              billedOutputTokens: 1500,
              overrunTokens: 0,
              verificationStatus: "AUTHORITATIVE",
              verificationNotes: "Verified",
              model: "gemini-3.6-flash",
            },
          },
          { session: mockSession }
        );
      },
      (err: any) => {
        assert.ok(err instanceof TokenInvariantViolationError);
        assert.ok(err.message.includes("insufficient reservedTokens or wallet missing"));
        return true;
      }
    );
  });

  // 6. Refund/Recovery Safety
  test("6. Refund/recovery safety: Missing wallet fails refund and prevents fabricated counters", async () => {
    const userId = new Types.ObjectId();
    const reservationId = new Types.ObjectId();
    const mockSession = createMockSession();

    TokenReservation.findOneAndUpdate = (() =>
      Promise.resolve({
        _id: reservationId,
        userId,
        reservedTokens: 2000,
        status: "REFUNDED",
      })) as any;

    // Wallet missing or insufficient reservedTokens
    TokenWallet.findOneAndUpdate = (() => Promise.resolve(null)) as any;

    await assert.rejects(
      async () => {
        await refundTokenReservation(
          {
            reservationId,
            userId,
            expectedVersion: 1,
            reason: "Generation aborted",
          },
          { session: mockSession }
        );
      },
      (err: any) => {
        assert.ok(err instanceof TokenInvariantViolationError);
        assert.ok(err.message.includes("insufficient reservedTokens or wallet missing"));
        return true;
      }
    );
  });

  // 7. Clean Initialization for New Accounts
  test("7. Clean initialization: Preserves valid initial wallet creation for genuinely new accounts with zero ledger history", async () => {
    const userId = new Types.ObjectId();
    const mockSession = createMockSession();

    let walletInDb: any = null;

    TokenWallet.findOne = (() => ({
      session: () => Promise.resolve(walletInDb),
    })) as any;

    User.findById = (() => ({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve({ _id: userId, plan: "free" }),
        }),
      }),
    })) as any;

    // Genuinely clean: zero history across all ledger collections
    TokenAllocation.exists = (() => mockQuery(null)) as any;
    TokenAllocation.countDocuments = (() => mockQuery(0)) as any;
    TokenAllocation.findOne = (() => mockQuery(null)) as any;

    TokenUsage.exists = (() => mockQuery(null)) as any;
    TokenReservation.exists = (() => mockQuery(null)) as any;

    TokenWallet.create = ((docs: any[]) => {
      walletInDb = {
        ...docs[0],
        save: () => Promise.resolve(walletInDb),
      };
      return Promise.resolve([walletInDb]);
    }) as any;

    TokenWallet.findOneAndUpdate = (() => Promise.resolve({
      userId,
      balance: 7000,
      reservedTokens: 3000,
    })) as any;

    TokenReservation.create = ((docs: any[]) => Promise.resolve(docs)) as any;

    const result = await createTokenReservation(
      {
        userId,
        conversationId: new Types.ObjectId(),
        userMessageId: new Types.ObjectId(),
        assistantMessageId: new Types.ObjectId(),
        inputTokens: 1000,
        maxOutputBudget: 2000,
      },
      { session: mockSession }
    );

    assert.ok(result.reservation);
    assert.equal(result.reservedAmount, 3000);
    assert.ok(walletInDb !== null, "Clean new account must have wallet created");
    assert.equal(walletInDb.totalAllocated, 10000);
  });

  // 8. Concurrent Initialization Collision Handling
  test("8. Concurrent initialization: Competing wallet creation catching E11000 on userId retrieves committed wallet", async () => {
    const userId = new Types.ObjectId();

    const committedWallet = {
      _id: new Types.ObjectId(),
      userId,
      balance: 10000,
      totalAllocated: 10000,
      totalUsed: 0,
      reservedTokens: 0,
      lastAllocatedPlan: "free",
    };

    let attempts = 0;
    // Standalone session: first attempt hits duplicate key on userId, subsequent findOne retrieves committed wallet
    TokenAllocation.findOne = (() => mockQuery(null)) as any;
    TokenAllocation.countDocuments = (() => mockQuery(0)) as any;
    TokenAllocation.exists = (() => mockQuery(null)) as any;
    TokenUsage.exists = (() => mockQuery(null)) as any;
    TokenReservation.exists = (() => mockQuery(null)) as any;

    TokenWallet.findOne = (() => {
      attempts++;
      if (attempts === 1) {
        // First findOne in session returns null to trigger creation
        return mockQuery(null);
      }
      // Retry in catch block finds the wallet committed by competitor
      return mockQuery(committedWallet);
    }) as any;

    TokenWallet.create = (() => {
      const err: any = new Error("E11000 duplicate key error collection: TokenWallet index: userId_1 dup key: { userId: ObjectId(...) }");
      err.code = 11000;
      err.keyPattern = { userId: 1 };
      throw err;
    }) as any;

    // Call allocateTokensForPlan without external session
    const wallet = await allocateTokensForPlan(userId, "free", {
      allocationKey: `initial:${userId.toString()}:free`,
    });

    assert.ok(wallet !== null);
    assert.equal(wallet.userId.toString(), userId.toString());
    assert.equal(wallet.balance, 10000);
  });

  // 9. Duplicate-Key Classification
  test("9. Duplicate-key classification: Distinguishes wallet userId conflict from unrelated E11000 errors", async () => {
    const userId = new Types.ObjectId();

    TokenAllocation.findOne = (() => mockQuery(null)) as any;
    TokenAllocation.countDocuments = (() => mockQuery(0)) as any;
    TokenAllocation.exists = (() => mockQuery(null)) as any;
    TokenUsage.exists = (() => mockQuery(null)) as any;
    TokenReservation.exists = (() => mockQuery(null)) as any;

    TokenWallet.findOne = (() => mockQuery(null)) as any;

    // Simulate an unrelated unique constraint error (e.g. duplicate email on a side effect)
    TokenWallet.create = (() => {
      const err: any = new Error("E11000 duplicate key error collection: otherCollection index: email_1");
      err.code = 11000;
      err.keyPattern = { email: 1 };
      throw err;
    }) as any;

    await assert.rejects(
      async () => {
        await allocateTokensForPlan(userId, "free", {
          allocationKey: `initial:${userId.toString()}:free`,
        });
      },
      (err: any) => {
        assert.equal(err.code, 11000);
        assert.deepEqual(err.keyPattern, { email: 1 });
        return true;
      }
    );
  });

  // 10. Error Sanitization
  test("10. Error sanitization: Client receives HTTP 503 and no internal ledger or database details", () => {
    const error = new TokenWalletCorruptedError();
    assert.equal(error.statusCode, 503);
    assert.equal(
      error.message,
      "Token wallet is temporarily unavailable due to state verification failure. Please contact support."
    );

    // Verify message contains no sensitive phrases
    const forbiddenDetails = [
      "mongodb",
      "TokenWallet",
      "TokenReservation",
      "collection",
      "E11000",
      "ObjectId",
      "totalAllocated",
      "cluster0",
    ];

    for (const phrase of forbiddenDetails) {
      assert.equal(
        error.message.toLowerCase().includes(phrase.toLowerCase()),
        false,
        `Error message must not leak '${phrase}'`
      );
    }
  });

  // 11. Transaction Isolation: External Session Rethrows Collision Immediately
  test("11. External transaction session: Rethrows wallet userId collision immediately to allow caller rollback", async () => {
    const userId = new Types.ObjectId();
    const mockSession = createMockSession();

    TokenAllocation.findOne = (() => mockQuery(null)) as any;
    TokenAllocation.countDocuments = (() => mockQuery(0)) as any;
    TokenUsage.exists = (() => mockQuery(null)) as any;
    TokenReservation.exists = (() => mockQuery(null)) as any;
    TokenWallet.findOne = (() => mockQuery(null)) as any;

    TokenWallet.create = (() => {
      const err: any = new Error("E11000 duplicate key error collection: TokenWallet index: userId_1");
      err.code = 11000;
      err.keyPattern = { userId: 1 };
      throw err;
    }) as any;

    // In an external session, collision must rethrow immediately without retrying findOne
    await assert.rejects(
      async () => {
        await allocateTokensForPlan(userId, "free", {
          session: mockSession,
          allocationKey: `initial:${userId.toString()}:free`,
        });
      },
      (err: any) => {
        assert.equal(err.code, 11000);
        return true;
      }
    );
  });

  // 12. Idempotent Replay with Existing Wallet
  test("12. Idempotency: Existing wallet and allocation record returns committed wallet without changing balance", async () => {
    const userId = new Types.ObjectId();
    const existingWallet = {
      _id: new Types.ObjectId(),
      userId,
      balance: 4200,
      totalAllocated: 10000,
      totalUsed: 5800,
      reservedTokens: 0,
      save: () => Promise.reject(new Error("wallet.save should not be called on duplicate grant")),
    };

    const existingAlloc = {
      _id: new Types.ObjectId(),
      userId,
      allocationKey: `initial:${userId.toString()}:free`,
    };

    TokenAllocation.findOne = (() => mockQuery(existingAlloc)) as any;
    TokenWallet.findOne = (() => mockQuery(existingWallet)) as any;

    const wallet = await allocateTokensForPlan(userId, "free", {
      allocationKey: `initial:${userId.toString()}:free`,
    });

    assert.equal(wallet.balance, 4200);
    assert.equal(wallet.totalUsed, 5800);
  });

  // 13. Reconciliation Tool: Safety Gate & Pure Evaluators
  test("13. Reconciliation tool: Safety gate rejects unconfirmed execution and evaluator detects invalid wallet", () => {
    // 1. Safety gate: fails if read-only flag is absent
    const unconfirmedEngine = new ReconciliationEngine({ readOnly: false });
    assert.throws(
      () => {
        unconfirmedEngine.assertReadOnlyMode();
      },
      (err: any) => {
        assert.ok(err instanceof ReconciliationConfigurationError);
        assert.ok(err.message.includes("Execution refused"));
        return true;
      }
    );

    // 2. Evaluator: flags corrupted wallet with negative balance as CRITICAL
    const corruptedWallet: any = {
      userId: new Types.ObjectId(),
      balance: -500,
      reservedTokens: 0,
      totalAllocated: 10000,
      totalUsed: 10500,
    };

    const findings = evaluateWalletValues(corruptedWallet);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleCode, "REC-01");
    assert.equal(findings[0].severity, "CRITICAL");
    assert.ok(findings[0].explanation.includes("negative"));
  });
});
