import type { Document, Types } from "mongoose";

export interface ITokenWallet {
  userId: Types.ObjectId;
  /** Current available liquid balance in the active billing period */
  balance: number;
  /** Current active plan period allowance (quota entitlement: 10k Free, 50k Pro, 100k Plus) */
  totalAllocated: number;
  /** Lifetime cumulative billed token usage across all billing periods */
  totalUsed: number;
  /** Current active reserved balance held by in-flight LLM generations */
  reservedTokens: number;
  /** Subscription plan tier associated with current active period allocation */
  lastAllocatedPlan?: string;
}

export interface ITokenWalletDocument extends ITokenWallet, Document {}