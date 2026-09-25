import type { Document, Types } from "mongoose";

export interface ITokenWallet {
  userId: Types.ObjectId;
  balance: number;
  totalAllocated: number;
  totalUsed: number;
  reservedTokens: number;
  lastAllocatedPlan?: string;
}

export interface ITokenWalletDocument extends ITokenWallet, Document {}