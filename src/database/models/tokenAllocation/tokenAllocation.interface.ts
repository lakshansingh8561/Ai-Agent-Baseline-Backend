import type { HydratedDocument, Types } from "mongoose";

export interface ITokenAllocation {
  userId: Types.ObjectId;
  allocationKey: string;
  checkoutId?: string | null;
  plan: "free" | "pro" | "plus";
  allocatedTokens: number;
  provider: "none" | "polar";
  providerSubscriptionId?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  status: "APPLIED";
  createdAt?: Date;
  updatedAt?: Date;
}

export type ITokenAllocationDocument = HydratedDocument<ITokenAllocation>;
