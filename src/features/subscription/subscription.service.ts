import mongoose, { type ClientSession } from "mongoose";
import {
  Subscription,
  type SubscriptionStatus,
} from "../../database/models/subscription/index.js";
import { User, type IUserDocument } from "../../database/models/user/index.js";
import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDER,
  type PlanKey,
} from "./subscription.constants.js";
import type { SafeSubscription, SafeCheckoutSession } from "./subscription.dto.js";
import { getPolarClient } from "./polar.client.js";

export class SubscriptionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = "SubscriptionError";
    this.statusCode = statusCode;
  }
}

/**
 * Retrieves the current subscription for an authenticated user.
 * If no Subscription document exists (e.g. existing user), safely returns their
 * effective free subscription entitlement based on User.plan without mutating the database.
 */
export const getUserSubscription = async (
  userId: string
): Promise<SafeSubscription> => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new SubscriptionError("Invalid user ID format", 400);
  }

  const userObjectId = new mongoose.Types.ObjectId(userId);

  // 1. Query for active or past_due subscription document
  const activeSub = await Subscription.findOne({
    userId: userObjectId,
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE] },
  }).sort({ createdAt: -1 });


  if (activeSub) {
    const planConfig =
      SUBSCRIPTION_PLANS[activeSub.plan as PlanKey] || SUBSCRIPTION_PLANS.free;

    return {
      id: activeSub._id.toString(),
      userId: activeSub.userId.toString(),
      plan: activeSub.plan,
      status: activeSub.status,
      provider: activeSub.provider,
      providerSubscriptionId: activeSub.providerSubscriptionId || null,
      providerProductId: activeSub.providerProductId || null,
      price: activeSub.price,
      currency: activeSub.currency,
      tokensPerPeriod: activeSub.tokensPerPeriod,
      billingInterval: planConfig.billingInterval,
      currentPeriodStart: activeSub.currentPeriodStart,
      currentPeriodEnd: activeSub.currentPeriodEnd || null,
      cancelAtPeriodEnd: activeSub.cancelAtPeriodEnd,
      createdAt: activeSub.createdAt,
      updatedAt: activeSub.updatedAt,
    };
  }

  // 2. Fallback for existing users without a Subscription document
  const user = await User.findById(userObjectId);
  if (!user) {
    throw new SubscriptionError("User not found", 404);
  }

  if (!user.isActive) {
    throw new SubscriptionError("User account is inactive", 403);
  }

  const effectivePlanKey = (user.plan as PlanKey) || "free";
  const planConfig =
    SUBSCRIPTION_PLANS[effectivePlanKey] || SUBSCRIPTION_PLANS.free;

  // Read-only deterministic response — DO NOT create or mutate documents in DB
  return {
    id: `effective_${user._id.toString()}`,
    userId: user._id.toString(),
    plan: planConfig.plan,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    provider: SUBSCRIPTION_PROVIDER.NONE,
    providerSubscriptionId: null,
    providerProductId: null,
    price: planConfig.price,
    currency: planConfig.currency,
    tokensPerPeriod: planConfig.tokensPerPeriod,
    billingInterval: planConfig.billingInterval,
    currentPeriodStart: user.createdAt || new Date(),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    createdAt: user.createdAt || new Date(),
    updatedAt: user.updatedAt || new Date(),
  };
};

/**
 * Creates the initial free subscription document for a newly registered user.
 * Must only be invoked during registration or explicit administrative backfills.
 * Does NOT perform any token allocation.
 */
export const createInitialFreeSubscription = async (
  userId: mongoose.Types.ObjectId,
  session?: ClientSession
): Promise<void> => {
  const freeConfig = SUBSCRIPTION_PLANS.free;

  const subscriptionData = {
    userId,
    plan: freeConfig.plan,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    provider: SUBSCRIPTION_PROVIDER.NONE,
    providerSubscriptionId: null,
    providerProductId: null,
    price: freeConfig.price,
    currency: freeConfig.currency,
    tokensPerPeriod: freeConfig.tokensPerPeriod,
    currentPeriodStart: new Date(),
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  };

  if (session) {
    const sub = new Subscription(subscriptionData);
    await sub.save({ session });
  } else {
    const sub = new Subscription(subscriptionData);
    await sub.save();
  }
};

/**
 * Creates a Polar Checkout Session for the authenticated user for POLAR_PRO_PRODUCT_ID.
 * 
 * Safety invariants:
 * - Does NOT mark user as Pro
 * - Does NOT modify TokenWallet or allocate tokens
 * - Does NOT create or mutate Subscription documents in database
 * - Validates user exists and is active
 * - Prevents duplicate active Pro subscriptions
 */
export const createProCheckoutSession = async (
  userId: string
): Promise<SafeCheckoutSession> => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new SubscriptionError("Invalid user ID format", 400);
  }

  const userObjectId = new mongoose.Types.ObjectId(userId);

  // 1. Verify user exists
  const user = await User.findById(userObjectId);
  if (!user) {
    throw new SubscriptionError("User not found", 404);
  }

  // 2. Verify user is active
  if (!user.isActive) {
    throw new SubscriptionError("User account is inactive", 403);
  }

  // 3. Verify user does not already have an active Pro subscription
  if (user.plan === "pro") {
    throw new SubscriptionError(
      "User already has an active Pro subscription",
      409
    );
  }

  const existingActiveSub = await Subscription.findOne({
    userId: userObjectId,
    plan: "pro",
    status: SUBSCRIPTION_STATUS.ACTIVE,
  });

  if (existingActiveSub) {
    throw new SubscriptionError(
      "User already has an active Pro subscription",
      409
    );
  }

  // 4. Verify Polar configuration
  const polarProductId = process.env.POLAR_PRO_PRODUCT_ID;
  if (!polarProductId) {
    throw new SubscriptionError(
      "POLAR_PRO_PRODUCT_ID is not configured in environment",
      500
    );
  }

  // 5. Build success and return URLs using FRONTEND_URL
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const cleanFrontendUrl =
    frontendUrl.startsWith("http://") || frontendUrl.startsWith("https://")
      ? frontendUrl
      : `https://${frontendUrl}`;

  const successUrl = `${cleanFrontendUrl}/app?checkout=success&checkout_id={CHECKOUT_ID}`;
  const returnUrl = `${cleanFrontendUrl}/app`;


  // 6. Create Polar Checkout Session using official SDK
  const polarClient = getPolarClient();

  const checkout = await polarClient.checkouts.create({
    products: [polarProductId],
    externalCustomerId: user._id.toString(),
    customerEmail: user.email || undefined,
    metadata: {
      userId: user._id.toString(),
    },
    successUrl,
    returnUrl,
  });

  if (!checkout || !checkout.url) {
    throw new SubscriptionError(
      "Failed to generate checkout session URL from Polar",
      502
    );
  }

  // 7. Return safe checkout details (never expose secrets or sensitive backend tokens)
  return {
    checkoutUrl: checkout.url,
    id: checkout.id,
    status: checkout.status,
    expiresAt: checkout.expiresAt ? new Date(checkout.expiresAt) : null,
  };
};

/**
 * Resolves the authenticated NexaMind user from verified Polar subscription data.
 * Authoritative resolution precedence:
 * 1. event.data.metadata.userId
 * 2. event.data.customer.externalId / external_id / customerExternalId
 * 3. event.data.customer.metadata.userId
 * 4. No correlation -> returns null (never correlates by customer.email)
 */
export const resolveUserFromPolarSubscription = async (
  subscriptionData: any
): Promise<IUserDocument | null> => {
  if (!subscriptionData) return null;

  // 1. Subscription metadata.userId
  const metadataUserId = subscriptionData.metadata?.userId;
  if (
    metadataUserId &&
    typeof metadataUserId === "string" &&
    mongoose.Types.ObjectId.isValid(metadataUserId)
  ) {
    const user = await User.findById(metadataUserId);
    if (user) return user;
  }

  // 2. Customer externalId / external_id / customerExternalId
  const customerExternalId =
    subscriptionData.customer?.externalId ||
    subscriptionData.customer?.external_id ||
    subscriptionData.customerExternalId;
  if (
    customerExternalId &&
    typeof customerExternalId === "string" &&
    mongoose.Types.ObjectId.isValid(customerExternalId)
  ) {
    const user = await User.findById(customerExternalId);
    if (user) return user;
  }

  // 3. Customer metadata.userId
  const customerMetaUserId = subscriptionData.customer?.metadata?.userId;
  if (
    customerMetaUserId &&
    typeof customerMetaUserId === "string" &&
    mongoose.Types.ObjectId.isValid(customerMetaUserId)
  ) {
    const user = await User.findById(customerMetaUserId);
    if (user) return user;
  }

  // Explicitly do NOT correlate by customer.email
  return null;
};


export interface PolarSubscriptionSyncResult {
  synchronized: boolean;
  action: "created" | "updated" | "cancelled" | "expired" | "past_due" | "ignored";
  userId?: string;
  subscriptionId?: string;
  providerSubscriptionId?: string;
  correlated: boolean;
  message?: string;
}

/**
 * Synchronizes verified Polar subscription lifecycle events into NexaMind.
 *
 * Safety invariants:
 * - Does NOT allocate tokens
 * - Does NOT modify TokenWallet
 * - Uses actual Polar subscription ID (event.data.id) for providerSubscriptionId
 * - Webhook delivery ID is recorded only in lastWebhookEventId for idempotency
 * - Duplicate events are idempotent and never produce duplicate records
 */
export const syncPolarSubscriptionEvent = async (
  event: any,
  webhookDeliveryId: string | null = null
): Promise<PolarSubscriptionSyncResult> => {
  const polarSub = event.data;
  if (!polarSub || typeof polarSub.id !== "string") {
    return {
      synchronized: false,
      action: "ignored",
      correlated: false,
      message: "Event data does not contain a valid Polar subscription ID",
    };
  }

  const polarSubscriptionId = polarSub.id;

  // 1. Correlate user using trusted metadata / external ID
  const user = await resolveUserFromPolarSubscription(polarSub);
  if (!user) {
    console.warn(
      `[Polar Sync] User correlation failed for subscription ${polarSubscriptionId}`
    );
    return {
      synchronized: false,
      action: "ignored",
      correlated: false,
      providerSubscriptionId: polarSubscriptionId,
      message: "User correlation not found",
    };
  }

  // 2. Query for existing subscription record by providerSubscriptionId
  let sub = await Subscription.findOne({
    providerSubscriptionId: polarSubscriptionId,
  });

  // Idempotency: If exact delivery ID matches, safely acknowledge without duplicate mutations
  if (sub && webhookDeliveryId && sub.lastWebhookEventId === webhookDeliveryId) {
    return {
      synchronized: true,
      action: "updated",
      correlated: true,
      userId: user._id.toString(),
      subscriptionId: sub._id.toString(),
      providerSubscriptionId: polarSubscriptionId,
      message: "Duplicate webhook delivery safely acknowledged (idempotent)",
    };
  }

  // 3. Extract verified timing and payload fields (support both camelCase from SDK and snake_case from raw JSON)
  const currentPeriodStart =
    polarSub.currentPeriodStart || polarSub.current_period_start
      ? new Date(polarSub.currentPeriodStart || polarSub.current_period_start)
      : new Date();
  const currentPeriodEnd =
    polarSub.currentPeriodEnd || polarSub.current_period_end
      ? new Date(polarSub.currentPeriodEnd || polarSub.current_period_end)
      : null;
  const cancelAtPeriodEnd = Boolean(
    polarSub.cancelAtPeriodEnd ?? polarSub.cancel_at_period_end
  );
  const endedAt =
    polarSub.endedAt || polarSub.ended_at
      ? new Date(polarSub.endedAt || polarSub.ended_at)
      : null;
  const now = new Date();


  let targetStatus: SubscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
  let targetUserPlan: "free" | "pro" = "pro";
  let targetCancelAtPeriodEnd: boolean = cancelAtPeriodEnd;
  let action: "created" | "updated" | "cancelled" | "expired" | "past_due" = "updated";

  switch (event.type) {
    case "subscription.created":
    case "subscription.active": {
      targetStatus = SUBSCRIPTION_STATUS.ACTIVE;
      targetUserPlan = "pro";
      targetCancelAtPeriodEnd = cancelAtPeriodEnd;
      action = sub ? "updated" : "created";
      break;
    }

    case "subscription.updated": {
      if (polarSub.status === "past_due") {
        targetStatus = SUBSCRIPTION_STATUS.PAST_DUE;
        targetUserPlan = "pro"; // grace period preserved
        action = "past_due";
      } else if (
        polarSub.status === "canceled" ||
        polarSub.status === "incomplete_expired"
      ) {
        if (endedAt && endedAt <= now) {
          targetStatus = SUBSCRIPTION_STATUS.CANCELLED;
          targetUserPlan = "free";
          targetCancelAtPeriodEnd = true;
          action = "cancelled";
        } else if (currentPeriodEnd && currentPeriodEnd <= now) {
          targetStatus = SUBSCRIPTION_STATUS.CANCELLED;
          targetUserPlan = "free";
          targetCancelAtPeriodEnd = true;
          action = "cancelled";
        } else {
          // Scheduled cancellation at period end - retain access
          targetStatus = SUBSCRIPTION_STATUS.ACTIVE;
          targetUserPlan = "pro";
          targetCancelAtPeriodEnd = true;
          action = "updated";
        }
      } else {
        targetStatus = SUBSCRIPTION_STATUS.ACTIVE;
        targetUserPlan = "pro";
        targetCancelAtPeriodEnd = cancelAtPeriodEnd;
        action = "updated";
      }
      break;
    }

    case "subscription.canceled": {
      // If cancellation is effective at period end and current period has not ended yet:
      // Preserve access until period end!
      const isPeriodActive = currentPeriodEnd && currentPeriodEnd > now;
      const isExplicitImmediate = endedAt && endedAt <= now;

      if (cancelAtPeriodEnd && isPeriodActive && !isExplicitImmediate) {
        targetStatus = SUBSCRIPTION_STATUS.ACTIVE;
        targetCancelAtPeriodEnd = true;
        targetUserPlan = "pro";
        action = "updated";
      } else {
        targetStatus = SUBSCRIPTION_STATUS.CANCELLED;
        targetCancelAtPeriodEnd = true;
        targetUserPlan = "free";
        action = "cancelled";
      }
      break;
    }

    case "subscription.past_due": {
      // Dunning grace period - retain Pro user access, record past_due status
      targetStatus = SUBSCRIPTION_STATUS.PAST_DUE;
      targetUserPlan = "pro";
      targetCancelAtPeriodEnd = cancelAtPeriodEnd;
      action = "past_due";
      break;
    }

    case "subscription.revoked": {
      // Immediate revocation - access cut off
      targetStatus = SUBSCRIPTION_STATUS.EXPIRED;
      targetCancelAtPeriodEnd = true;
      targetUserPlan = "free";
      action = "expired";
      break;
    }

    case "subscription.uncanceled": {
      targetStatus = SUBSCRIPTION_STATUS.ACTIVE;
      targetCancelAtPeriodEnd = false;
      targetUserPlan = "pro";
      action = "updated";
      break;
    }

    default: {
      console.info(`[Polar Sync] Unhandled subscription event type: ${event.type}`);
      return {
        synchronized: false,
        action: "ignored",
        correlated: true,
        providerSubscriptionId: polarSubscriptionId,
        message: `Unhandled event type: ${event.type}`,
      };
    }
  }

  // 4. Update or create the Subscription record
  const price =
    typeof polarSub.amount === "number"
      ? polarSub.amount / 100
      : SUBSCRIPTION_PLANS.pro.price;
  const currency = (polarSub.currency || "USD").toUpperCase();
  const providerProductId =
    polarSub.productId ||
    polarSub.product_id ||
    polarSub.product?.id ||
    process.env.POLAR_PRO_PRODUCT_ID ||
    null;


  if (!sub) {
    // If user has an initial free subscription with provider "none", upgrade it
    sub = await Subscription.findOne({
      userId: user._id,
      provider: SUBSCRIPTION_PROVIDER.NONE,
      status: SUBSCRIPTION_STATUS.ACTIVE,
    });

    if (sub) {
      sub.provider = SUBSCRIPTION_PROVIDER.POLAR;
      sub.providerSubscriptionId = polarSubscriptionId;
      sub.providerProductId = providerProductId;
      sub.plan = "pro";
      sub.status = targetStatus;
      sub.price = price;
      sub.currency = currency;
      sub.tokensPerPeriod = SUBSCRIPTION_PLANS.pro.tokensPerPeriod;
      sub.currentPeriodStart = currentPeriodStart;
      sub.currentPeriodEnd = currentPeriodEnd;
      sub.cancelAtPeriodEnd = targetCancelAtPeriodEnd;
      sub.lastWebhookEventId = webhookDeliveryId;
      await sub.save();
    } else {
      sub = new Subscription({
        userId: user._id,
        plan: "pro",
        status: targetStatus,
        provider: SUBSCRIPTION_PROVIDER.POLAR,
        providerSubscriptionId: polarSubscriptionId,
        providerProductId,
        price,
        currency,
        tokensPerPeriod: SUBSCRIPTION_PLANS.pro.tokensPerPeriod,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: targetCancelAtPeriodEnd,
        lastWebhookEventId: webhookDeliveryId,
      });
      await sub.save();
    }
  } else {
    // Update existing Polar subscription
    sub.status = targetStatus;
    sub.cancelAtPeriodEnd = targetCancelAtPeriodEnd;
    sub.currentPeriodStart = currentPeriodStart;
    sub.currentPeriodEnd = currentPeriodEnd;
    if (providerProductId) sub.providerProductId = providerProductId;
    sub.price = price;
    sub.currency = currency;
    sub.lastWebhookEventId = webhookDeliveryId;
    await sub.save();
  }

  // 5. Update User.plan if changed
  if (user.plan !== targetUserPlan) {
    user.plan = targetUserPlan;
    await user.save();
  }

  return {
    synchronized: true,
    action,
    correlated: true,
    userId: user._id.toString(),
    subscriptionId: sub._id.toString(),
    providerSubscriptionId: polarSubscriptionId,
    message: "Subscription successfully synchronized",
  };
};


