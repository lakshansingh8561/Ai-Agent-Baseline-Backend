import type { Document, Types } from "mongoose";

export type SubscriptionPlan = "free" | "pro";

export type SubscriptionStatus =
  | "active"
  | "cancelled"
  | "expired"
  | "past_due";

export type SubscriptionProvider = "none" | "polar";

export interface ISubscription {
  userId: Types.ObjectId;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  provider: SubscriptionProvider;
  providerSubscriptionId?: string | null;
  providerProductId?: string | null;
  price: number;
  currency: string;
  tokensPerPeriod: number;
  currentPeriodStart: Date;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd: boolean;
  lastWebhookEventId?: string | null;
}


export interface ISubscriptionDocument extends ISubscription, Document {
  createdAt: Date;
  updatedAt: Date;
}
