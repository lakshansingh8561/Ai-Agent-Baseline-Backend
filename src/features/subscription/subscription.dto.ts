import type {
  SubscriptionPlan,
  SubscriptionStatus,
  SubscriptionProvider,
} from "../../database/models/subscription/index.js";

export interface SafeSubscription {
  id: string;
  userId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  provider: SubscriptionProvider;
  providerSubscriptionId: string | null;
  providerProductId: string | null;
  price: number;
  currency: string;
  tokensPerPeriod: number;
  billingInterval: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubscriptionResponse {
  success: boolean;
  message?: string;
  data: SafeSubscription;
}

export interface SafeCheckoutSession {
  checkoutUrl: string;
  id?: string;
  status?: string;
  expiresAt?: Date | null;
  upgradedDirectly?: boolean;
  plan?: "plus" | "pro";
}

export interface CheckoutSessionResponse {
  success: boolean;
  message?: string;
  data: SafeCheckoutSession;
}

import { z } from "zod";

export const createCheckoutSchema = z.object({
  plan: z.enum(["plus", "pro"]).optional().default("pro"),
});

export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;

