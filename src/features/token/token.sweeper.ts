import crypto from "node:crypto";
import { TokenReservation } from "../../database/models/tokenReservation/index.js";
import {
  claimExpiredReservation,
  resolveRecoveringReservation,
  quarantineTokenReservation,
  reconcileAmbiguousCommit,
} from "./token.recovery.js";

export const DEFAULT_SWEEPER_INTERVAL_MS = 60 * 1000; // 60 seconds
export const DEFAULT_SWEEPER_BATCH_SIZE = 50; // 50 reservations per batch

export interface TokenSweeperOptions {
  intervalMs?: number;
  batchSize?: number;
  workerId?: string;
  runImmediately?: boolean;
  candidateFilter?: Record<string, any>;
}

export interface SweepBatchStats {
  discovered: number;
  claimed: number;
  resolved: number;
  quarantined: number;
  skipped: number;
  errors: number;
  skippedDueToOverlap?: boolean;
}

export class TokenSweeper {
  private timer: NodeJS.Timeout | null = null;
  private isSweeping = false;
  private isStopping = false;
  private inFlightSweep: Promise<SweepBatchStats> | null = null;
  public readonly workerId: string;
  public readonly intervalMs: number;
  public readonly batchSize: number;
  public readonly candidateFilter?: Record<string, any>;

  constructor(options: TokenSweeperOptions = {}) {
    this.intervalMs =
      options.intervalMs ??
      (process.env.TOKEN_SWEEPER_INTERVAL_MS
        ? Number.parseInt(process.env.TOKEN_SWEEPER_INTERVAL_MS, 10)
        : DEFAULT_SWEEPER_INTERVAL_MS);

    this.batchSize =
      options.batchSize ??
      (process.env.TOKEN_SWEEPER_BATCH_SIZE
        ? Number.parseInt(process.env.TOKEN_SWEEPER_BATCH_SIZE, 10)
        : DEFAULT_SWEEPER_BATCH_SIZE);

    this.workerId =
      options.workerId ?? `sweeper-${process.pid}-${crypto.randomUUID()}`;

    this.candidateFilter = options.candidateFilter;
  }

  /**
   * Whether a sweep batch is currently actively executing in this process.
   */
  public get isRunning(): boolean {
    return this.isSweeping;
  }

  /**
   * Whether the background interval timer is scheduled.
   */
  public get isScheduled(): boolean {
    return this.timer !== null;
  }

  /**
   * Executes a single bounded sweep batch over expired reservations.
   * Prevents overlapping runs within the same process.
   */
  public async runSweepOnce(): Promise<SweepBatchStats> {
    if (this.isSweeping) {
      return {
        discovered: 0,
        claimed: 0,
        resolved: 0,
        quarantined: 0,
        skipped: 0,
        errors: 0,
        skippedDueToOverlap: true,
      };
    }

    if (this.isStopping) {
      return {
        discovered: 0,
        claimed: 0,
        resolved: 0,
        quarantined: 0,
        skipped: 0,
        errors: 0,
      };
    }

    this.isSweeping = true;
    const sweepPromise = this.executeSweepBatch();
    this.inFlightSweep = sweepPromise;

    try {
      return await sweepPromise;
    } finally {
      this.isSweeping = false;
      this.inFlightSweep = null;
    }
  }

  private async executeSweepBatch(): Promise<SweepBatchStats> {
    const stats: SweepBatchStats = {
      discovered: 0,
      claimed: 0,
      resolved: 0,
      quarantined: 0,
      skipped: 0,
      errors: 0,
    };

    const now = new Date();

    try {
      const query: Record<string, any> = {
        $or: [
          { status: "RESERVED", lockExpiresAt: { $lte: now } },
          { status: "RECOVERING", recoveryExpiresAt: { $lte: now } },
        ],
        ...(this.candidateFilter ?? {}),
      };

      const candidates = await TokenReservation.find(query)
        .sort({ lockExpiresAt: 1, recoveryExpiresAt: 1 })
        .limit(this.batchSize)
        .select("_id status version")
        .lean();

      stats.discovered = candidates.length;

      // 2. Process each candidate with atomic claim and isolated error handling
      for (const candidate of candidates) {
        if (this.isStopping) {
          break;
        }

        try {
          // Atomically claim candidate; never assume discovery query implies ownership
          const claimed = await claimExpiredReservation({
            reservationId: candidate._id,
            workerId: this.workerId,
            expectedVersion: candidate.version,
          });

          if (!claimed) {
            // Concurrently claimed by another worker, finalized, or version moved
            stats.skipped++;
            continue;
          }

          stats.claimed++;

          // Attempt multi-document transaction resolution
          try {
            await resolveRecoveringReservation({
              reservationId: claimed._id,
              workerId: this.workerId,
              expectedVersion: claimed.version,
              reason: "Automated recovery of expired reservation",
            });
            stats.resolved++;
          } catch (resolveError: any) {
            // Transaction failed or hit ambiguous commit: reconcile against primary
            const reconciliation = await reconcileAmbiguousCommit({
              reservationId: claimed._id,
              workerId: this.workerId,
              expectedVersion: claimed.version,
            });

            if (reconciliation.status === "COMMITTED") {
              stats.resolved++;
            } else if (
              reconciliation.status === "UNRESOLVED_CURRENT_VERSION"
            ) {
              const leaseRemainingMs =
                reconciliation.reservation?.recoveryExpiresAt
                  ? reconciliation.reservation.recoveryExpiresAt.getTime() -
                    Date.now()
                  : 0;

              // If at least 30s lease remaining, retry once with strict CAS
              let retriedSuccessfully = false;
              if (leaseRemainingMs > 30_000) {
                try {
                  await resolveRecoveringReservation({
                    reservationId: claimed._id,
                    workerId: this.workerId,
                    expectedVersion: claimed.version,
                    reason: "Automated retry of unresolved reservation",
                  });
                  stats.resolved++;
                  retriedSuccessfully = true;
                } catch {
                  // Fall through to quarantine
                }
              }

              if (!retriedSuccessfully) {
                const quarantined = await quarantineTokenReservation({
                  reservationId: claimed._id,
                  workerId: this.workerId,
                  expectedVersion: claimed.version,
                  reason: `Unresolved commit outcome: ${resolveError.message}`,
                });
                if (quarantined) {
                  stats.quarantined++;
                } else {
                  stats.skipped++;
                }
              }
            } else if (reconciliation.status === "STOLEN") {
              stats.skipped++;
            } else {
              // Indeterminate state: quarantine with CAS to protect audit trail
              const quarantined = await quarantineTokenReservation({
                reservationId: claimed._id,
                workerId: this.workerId,
                expectedVersion: claimed.version,
                reason: `Indeterminate recovery outcome: ${resolveError.message}`,
              });
              if (quarantined) {
                stats.quarantined++;
              } else {
                stats.skipped++;
              }
            }
          }
        } catch (candidateErr) {
          stats.errors++;
          console.error(
            `[TokenSweeper] Unhandled error recovering reservation ${candidate._id}:`,
            candidateErr
          );
        }
      }
    } catch (batchErr) {
      stats.errors++;
      console.error("[TokenSweeper] Batch execution query failed:", batchErr);
    }

    return stats;
  }

  /**
   * Starts the background sweeper timer.
   */
  public start(runImmediately = false): void {
    if (this.timer) {
      return;
    }

    this.isStopping = false;

    if (runImmediately) {
      this.runSweepOnce().catch((err) => {
        console.error("[TokenSweeper] Initial sweep run failed:", err);
      });
    }

    this.timer = setInterval(() => {
      this.runSweepOnce().catch((err) => {
        console.error("[TokenSweeper] Periodic sweep run failed:", err);
      });
    }, this.intervalMs);

    // Unref timer so it doesn't prevent Node process exit in standalone scripts
    this.timer.unref();
  }

  /**
   * Stops the background timer and awaits any in-flight sweep batch before resolving.
   */
  public async stop(): Promise<void> {
    this.isStopping = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.inFlightSweep) {
      try {
        await this.inFlightSweep;
      } catch {
        // Ignored during shutdown
      }
    }

    this.isSweeping = false;
  }
}

// Global process-level singleton instance
let globalSweeper: TokenSweeper | null = null;

export const getTokenSweeper = (
  options?: TokenSweeperOptions
): TokenSweeper => {
  if (!globalSweeper) {
    globalSweeper = new TokenSweeper(options);
  }
  return globalSweeper;
};

export const startTokenSweeper = (
  options?: TokenSweeperOptions
): TokenSweeper => {
  const sweeper = getTokenSweeper(options);
  sweeper.start(options?.runImmediately ?? false);
  return sweeper;
};

export const stopTokenSweeper = async (): Promise<void> => {
  if (globalSweeper) {
    await globalSweeper.stop();
    globalSweeper = null;
  }
};
