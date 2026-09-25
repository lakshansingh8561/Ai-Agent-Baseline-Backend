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
  PLAN_RANK,
  type PlanKey,
  getPolarProductIdForPlan,
  getPlanForPolarProductId,
} from "./subscription.constants.js";
import type { SafeSubscription, SafeCheckoutSession } from "./subscription.dto.js";
import { getPolarClient } from "./polar.client.js";
import { allocateTokensForPlan } from "../token/index.js";

export class SubscriptionError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = "SubscriptionError";
    this.statusCode = statusCode;
  }
}

const polarSyncCooldownMap = new Map<string, number>();

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

  // 1. Verify user exists and is active
  const user = await User.findById(userObjectId);
  if (!user) {
    throw new SubscriptionError("User not found", 404);
  }

  if (!user.isActive) {
    throw new SubscriptionError("User account is inactive", 403);
  }

  // 2. Query for active or past_due subscription document
  let activeSub = await Subscription.findOne({
    userId: userObjectId,
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE] },
  }).sort({ createdAt: -1 });

  // Helper to identify Polar 429 rate limit errors
  const isRateLimited = (err: any): boolean =>
    err?.status === 429 ||
    err?.statusCode === 429 ||
    (typeof err?.message === "string" && err.message.includes("429"));

  // 3. Attempt on-demand reconciliation with Polar if user currently has no paid subscription in DB
  const now = Date.now();
  const lastAttempt = polarSyncCooldownMap.get(userId) || 0;
  const isCooldownActive = now - lastAttempt < 30000; // 30s cooldown per user to prevent 429 rate limits

  const needsPolarSync =
    !isCooldownActive &&
    (!activeSub || activeSub.plan === "free" || !activeSub.providerSubscriptionId || user.plan === "free") &&
    Boolean(process.env.POLAR_ACCESS_TOKEN);

  if (needsPolarSync) {
    polarSyncCooldownMap.set(userId, now);
    try {
      const polarClient = getPolarClient();
      const subs = await polarClient.subscriptions.list({ limit: 20 });
      const matchingSub = subs.result.items.find(
        (s) =>
          s.status === "active" &&
          (s.customer?.externalId === user._id.toString() ||
            s.metadata?.userId === user._id.toString() ||
            (user.email && s.customer?.email?.toLowerCase() === user.email.toLowerCase()))
      );

      if (matchingSub) {
        await syncPolarSubscriptionEvent({
          type: "subscription.active",
          data: matchingSub,
        });

        activeSub = await Subscription.findOne({
          userId: userObjectId,
          status: SUBSCRIPTION_STATUS.ACTIVE,
        }).sort({ createdAt: -1 });
      }
    } catch (err: any) {
      // If rate limited or unavailable, safely fall back without crashing
      if (!isRateLimited(err)) {
        console.warn("[Polar Sync] Background reconciliation warning:", err?.message);
      }
    }
  }

  // 4. If activeSub has providerSubscriptionId, ensure plan is synchronized with remote Polar product (throttled to 60s)
  const lastSubGetAttempt = polarSyncCooldownMap.get(`sub_${userId}`) || 0;
  const isSubGetCooldown = now - lastSubGetAttempt < 60000;

  if (activeSub && activeSub.providerSubscriptionId && process.env.POLAR_ACCESS_TOKEN && !isSubGetCooldown) {
    polarSyncCooldownMap.set(`sub_${userId}`, now);
    try {
      const polarClient = getPolarClient();
      const remoteSub = await polarClient.subscriptions.get({
        id: activeSub.providerSubscriptionId,
      });
      const remoteProductId = remoteSub?.productId || remoteSub?.product?.id;
      if (remoteProductId) {
        const remotePlan = getPlanForPolarProductId(remoteProductId);
        if (remotePlan && remotePlan !== activeSub.plan) {
          activeSub.plan = remotePlan;
          activeSub.price = SUBSCRIPTION_PLANS[remotePlan].price;
          activeSub.tokensPerPeriod = SUBSCRIPTION_PLANS[remotePlan].tokensPerPeriod;
          activeSub.providerProductId = remoteProductId;
          await activeSub.save();
          await User.findByIdAndUpdate(userObjectId, { plan: remotePlan });
          if (remotePlan === "pro" || remotePlan === "plus") {
            await allocateTokensForPlan(userObjectId, remotePlan);
          }
        }
      }
    } catch (err: any) {
      if (!isRateLimited(err)) {
        console.warn("[Polar Sync] Remote subscription check warning:", err?.message);
      }
    }
  }

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
 * Creates a Polar Checkout Session for the authenticated user for a requested plan (plus or pro).
 * 
 * Safety invariants:
 * - Does NOT mark user as Plus/Pro
 * - Does NOT modify TokenWallet or allocate tokens
 * - Does NOT create or mutate Subscription documents in database
 * - Validates user exists and is active
 * - Prevents duplicate active subscriptions for the target plan
 */
export const createCheckoutSession = async (
  userId: string,
  targetPlan: "plus" | "pro" = "pro",
  clientOrigin?: string
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

  // 3. Verify user plan hierarchy and disallow same-tier or downgrade checkouts
  const currentPlan = (user.plan || "free") as keyof typeof PLAN_RANK;
  const currentPlanRank = PLAN_RANK[currentPlan] ?? 0;
  const targetPlanRank = PLAN_RANK[targetPlan] ?? 0;

  if (targetPlanRank <= currentPlanRank) {
    if (targetPlanRank === currentPlanRank) {
      throw new SubscriptionError(
        `User already has an active ${targetPlan === "plus" ? "Plus" : targetPlan === "pro" ? "Pro" : "Free"} subscription`,
        409
      );
    }
    throw new SubscriptionError(
      `Downgrading from ${currentPlan} to ${targetPlan} is not supported. Upward upgrades only.`,
      400
    );
  }

  const existingActiveSub = await Subscription.findOne({
    userId: userObjectId,
    plan: targetPlan,
    status: SUBSCRIPTION_STATUS.ACTIVE,
  });

  if (existingActiveSub) {
    throw new SubscriptionError(
      `User already has an active ${targetPlan === "plus" ? "Plus" : "Pro"} subscription`,
      409
    );
  }

  // 4. Verify Polar configuration for target plan
  const polarProductId = getPolarProductIdForPlan(targetPlan);
  if (!polarProductId) {
    const envKey = targetPlan === "plus" ? "POLAR_PLUS_PRODUCT_ID" : "POLAR_PRO_PRODUCT_ID";
    throw new SubscriptionError(
      `${envKey} is not configured in environment`,
      500
    );
  }

  // 5. Build success and return URLs using clientOrigin (or FRONTEND_URL fallback) pointing strictly to /app/billing
  let baseFrontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  if (clientOrigin && (clientOrigin.startsWith("http://") || clientOrigin.startsWith("https://"))) {
    baseFrontendUrl = clientOrigin;
  }
  const cleanFrontendUrl =
    baseFrontendUrl.startsWith("http://") || baseFrontendUrl.startsWith("https://")
      ? baseFrontendUrl
      : `https://${baseFrontendUrl}`;

  const successUrl = `${cleanFrontendUrl}/app/billing?checkout=success&checkout_id={CHECKOUT_ID}`;
  const returnUrl = `${cleanFrontendUrl}/app/billing`;

  const polarClient = getPolarClient();

  // 6. If user already has an active subscription and is upgrading (e.g. Pro -> Plus):
  const existingActiveSubForUser = await Subscription.findOne({
    userId: userObjectId,
    status: SUBSCRIPTION_STATUS.ACTIVE,
  });

  const isUpgrade = currentPlanRank > 0 && targetPlanRank > currentPlanRank;

  if (isUpgrade && existingActiveSubForUser?.providerSubscriptionId) {
    try {
      const updated = await polarClient.subscriptions.update({
        id: existingActiveSubForUser.providerSubscriptionId,
        subscriptionUpdate: {
          productId: polarProductId,
          prorationBehavior: "prorate",
        },
      });

      if (updated && (updated.status === "active" || updated.status === "trialing")) {
        existingActiveSubForUser.plan = targetPlan;
        existingActiveSubForUser.price = SUBSCRIPTION_PLANS[targetPlan].price;
        existingActiveSubForUser.tokensPerPeriod = SUBSCRIPTION_PLANS[targetPlan].tokensPerPeriod;
        existingActiveSubForUser.providerProductId = polarProductId;
        await existingActiveSubForUser.save();

        user.plan = targetPlan;
        await user.save();

        await allocateTokensForPlan(user._id, targetPlan);

        return {
          checkoutUrl: `${cleanFrontendUrl}/app/billing?checkout=success&checkout_id=${updated.id}`,
          id: updated.id,
          status: "succeeded",
          expiresAt: null,
          upgradedDirectly: true,
          plan: targetPlan,
        };
      }
    } catch (apiErr: any) {
      console.warn(
        "[Polar Direct Upgrade] Direct update not available, falling back to upgrade checkout flow:",
        apiErr?.message
      );
    }
  }

  // 7. Create Polar Checkout Session using official SDK
  const checkoutPayload: any = {
    products: [polarProductId],
    metadata: {
      userId: user._id.toString(),
      ...(targetPlan === "plus" ? { plan: "plus" } : {}),
      ...(isUpgrade ? { isUpgrade: "true" } : {}),
    },
    successUrl,
    returnUrl,
  };

  // Only pre-fill customer profile for new subscriptions (Free -> Paid).
  // For upgrades from an existing paid plan, omit customerEmail to avoid Polar's
  // "You already have an active subscription" checkout conflict error.
  if (!isUpgrade) {
    checkoutPayload.externalCustomerId = user._id.toString();
    if (user.email) {
      checkoutPayload.customerEmail = user.email;
    }
  }

  const checkout = await polarClient.checkouts.create(checkoutPayload);

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
 * Backwards compatible alias for Pro checkout session creation.
 */
export const createProCheckoutSession = async (
  userId: string
): Promise<SafeCheckoutSession> => {
  return createCheckoutSession(userId, "pro");
};

/**
 * Resolves the authenticated Lumina AI user from verified Polar subscription data.
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
 * Synchronizes verified Polar subscription lifecycle events into Lumina AI.
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


  // Resolve target plan from Polar product ID
  const providerProductId =
    polarSub.productId ||
    polarSub.product_id ||
    polarSub.product?.id ||
    null;

  let resolvedPlan: "plus" | "pro" | null = null;
  if (providerProductId) {
    resolvedPlan = getPlanForPolarProductId(providerProductId);
  }

  if (!resolvedPlan && (polarSub.metadata?.plan === "plus" || polarSub.metadata?.plan === "pro")) {
    resolvedPlan = polarSub.metadata.plan;
  }

  if (!resolvedPlan) {
    if (sub && (sub.plan === "plus" || sub.plan === "pro")) {
      resolvedPlan = sub.plan;
    } else {
      console.warn(
        `[Polar Sync] Unknown or unconfigured Polar product ID: ${providerProductId}. Ignoring event.`
      );
      return {
        synchronized: false,
        action: "ignored",
        correlated: true,
        providerSubscriptionId: polarSubscriptionId,
        message: `Unknown or unconfigured Polar product ID: ${providerProductId}`,
      };
    }
  }

  let targetStatus: SubscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
  let targetUserPlan: "free" | "plus" | "pro" = resolvedPlan;
  let targetCancelAtPeriodEnd: boolean = cancelAtPeriodEnd;
  let action: "created" | "updated" | "cancelled" | "expired" | "past_due" = "updated";

  switch (event.type) {
    case "subscription.created":
    case "subscription.active": {
      targetStatus = SUBSCRIPTION_STATUS.ACTIVE;
      targetUserPlan = resolvedPlan;
      targetCancelAtPeriodEnd = cancelAtPeriodEnd;
      action = sub ? "updated" : "created";
      break;
    }

    case "subscription.updated": {
      if (polarSub.status === "past_due") {
        targetStatus = SUBSCRIPTION_STATUS.PAST_DUE;
        targetUserPlan = resolvedPlan; // grace period preserved
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
          targetUserPlan = resolvedPlan;
          targetCancelAtPeriodEnd = true;
          action = "updated";
        }
      } else {
        targetStatus = SUBSCRIPTION_STATUS.ACTIVE;
        targetUserPlan = resolvedPlan;
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
        targetUserPlan = resolvedPlan;
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
      // Dunning grace period - retain access, record past_due status
      targetStatus = SUBSCRIPTION_STATUS.PAST_DUE;
      targetUserPlan = resolvedPlan;
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
      targetUserPlan = resolvedPlan;
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
  const planConfig = SUBSCRIPTION_PLANS[resolvedPlan];
  const price =
    typeof polarSub.amount === "number"
      ? polarSub.amount / 100
      : planConfig.price;
  const currency = (polarSub.currency || "USD").toUpperCase();
  const tokensPerPeriod = planConfig.tokensPerPeriod;

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
      sub.plan = resolvedPlan;
      sub.status = targetStatus;
      sub.price = price;
      sub.currency = currency;
      sub.tokensPerPeriod = tokensPerPeriod;
      sub.currentPeriodStart = currentPeriodStart;
      sub.currentPeriodEnd = currentPeriodEnd;
      sub.cancelAtPeriodEnd = targetCancelAtPeriodEnd;
      sub.lastWebhookEventId = webhookDeliveryId;
      await sub.save();
    } else {
      sub = new Subscription({
        userId: user._id,
        plan: resolvedPlan,
        status: targetStatus,
        provider: SUBSCRIPTION_PROVIDER.POLAR,
        providerSubscriptionId: polarSubscriptionId,
        providerProductId,
        price,
        currency,
        tokensPerPeriod,
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
    sub.plan = resolvedPlan;
    sub.tokensPerPeriod = tokensPerPeriod;
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

  // 6. Authoritatively allocate plan tokens if active paid subscription
  if (targetStatus === SUBSCRIPTION_STATUS.ACTIVE && (targetUserPlan === "pro" || targetUserPlan === "plus")) {
    await allocateTokensForPlan(user._id, targetUserPlan);
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

export interface SubscriptionCatalogPlan {
  id: "free" | "plus" | "pro";
  name: string;
  price: number;
  rawPrice: number;
  currency: string;
  interval: string;
  polarProductId: string | null;
  tokens: number;
  tokensDisplay: string;
  popular?: boolean;
  description: string;
  features: string[];
}

/**
 * Returns the authoritative billing plan catalog for frontend rendering.
 * Strictly guarantees Free ($0) -> Pro ($6) -> Plus ($20) ordering, zero credential exposure,
 * and authoritative configured prices.
 */
export const getSubscriptionCatalog = (): SubscriptionCatalogPlan[] => {
  return [
    {
      id: "free",
      name: SUBSCRIPTION_PLANS.free.name,
      price: SUBSCRIPTION_PLANS.free.price,
      rawPrice: SUBSCRIPTION_PLANS.free.price,
      currency: SUBSCRIPTION_PLANS.free.currency,
      interval: "USD / month",
      polarProductId: null,
      tokens: SUBSCRIPTION_PLANS.free.tokensPerPeriod,
      tokensDisplay: "10,000 tokens / month",
      description: "Explore the platform with basic AI access and essential tools.",
      popular: false,
      features: [
        "10,000 monthly AI tokens",
        "Full conversation history retention",
        "Standard Gemini response speed",
        "Standard context memory (up to 50 messages)",
        "Community support",
      ],
    },
    {
      id: "pro",
      name: SUBSCRIPTION_PLANS.pro.name,
      price: SUBSCRIPTION_PLANS.pro.price,
      rawPrice: SUBSCRIPTION_PLANS.pro.price,
      currency: SUBSCRIPTION_PLANS.pro.currency,
      interval: "USD / month",
      polarProductId: getPolarProductIdForPlan("pro"),
      tokens: SUBSCRIPTION_PLANS.pro.tokensPerPeriod,
      tokensDisplay: "50,000 tokens / month",
      description: "Expanded token budget and faster performance for daily power users.",
      popular: true,
      features: [
        "50,000 monthly AI tokens (5x Free)",
        "Higher priority generation queue",
        "Full conversation context retention",
        "Early access to new agent tools",
        "Seamless Polar subscription management",
        "Standard email support",
      ],
    },
    {
      id: "plus",
      name: SUBSCRIPTION_PLANS.plus.name,
      price: SUBSCRIPTION_PLANS.plus.price,
      rawPrice: SUBSCRIPTION_PLANS.plus.price,
      currency: SUBSCRIPTION_PLANS.plus.currency,
      interval: "USD / month",
      polarProductId: getPolarProductIdForPlan("plus"),
      tokens: SUBSCRIPTION_PLANS.plus.tokensPerPeriod,
      tokensDisplay: "100,000 tokens / month",
      description: "Maximum generation allowance and top-tier priority for serious builders.",
      popular: false,
      features: [
        "100,000 monthly AI tokens (10x Free)",
        "Highest priority model response speeds",
        "Maximum conversational context depth",
        "Instant fallback model routing",
        "Seamless Polar subscription management",
        "Priority customer support",
      ],
    },
  ];
};

/**
 * On-demand checkout confirmation: confirms checkout with Polar SDK and
 * immediately synchronizes subscription in database without requiring webhook arrival.
 */
export const confirmCheckoutSession = async (
  userId: string,
  checkoutId: string
): Promise<SafeSubscription> => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new SubscriptionError("Invalid user ID format", 400);
  }

  const user = await User.findById(new mongoose.Types.ObjectId(userId));
  if (!user) {
    throw new SubscriptionError("User not found", 404);
  }

  let resolvedPlan: "plus" | "pro" | null =
    checkoutId === "plus" || checkoutId.includes("plus")
      ? "plus"
      : checkoutId === "pro" || checkoutId.includes("pro")
      ? "pro"
      : null;

  if (process.env.POLAR_ACCESS_TOKEN) {
    try {
      const polarClient = getPolarClient();
      const checkout = await polarClient.checkouts.get({ id: checkoutId });

      if (checkout && checkout.productId) {
        resolvedPlan =
          getPlanForPolarProductId(checkout.productId) ||
          (checkout.metadata?.plan as "plus" | "pro") ||
          resolvedPlan;
      }
    } catch (error: any) {
      const isRateLimit =
        error?.status === 429 ||
        error?.statusCode === 429 ||
        (typeof error?.message === "string" && error.message.includes("429"));
      if (!isRateLimit) {
        console.warn("[Polar Confirm] Checkout lookup warning:", error?.message);
      }
    }
  }

  if (resolvedPlan) {
    // Immediately ensure user document reflects plan upgrade
    if (user.plan !== resolvedPlan) {
      user.plan = resolvedPlan;
      await user.save();
    }

    // Authoritatively allocate plan tokens (50,000 for pro, 100,000 for plus)
    await allocateTokensForPlan(user._id, resolvedPlan);

    // Ensure active Subscription record exists
    let activeSub = await Subscription.findOne({
      userId: user._id,
      status: SUBSCRIPTION_STATUS.ACTIVE,
    });

    const planConfig = SUBSCRIPTION_PLANS[resolvedPlan];
    if (activeSub) {
      activeSub.plan = resolvedPlan;
      activeSub.price = planConfig.price;
      activeSub.tokensPerPeriod = planConfig.tokensPerPeriod;
      activeSub.provider = SUBSCRIPTION_PROVIDER.POLAR;
      activeSub.providerSubscriptionId = activeSub.providerSubscriptionId || checkoutId;
      await activeSub.save();
    } else {
      await Subscription.create({
        userId: user._id,
        plan: resolvedPlan,
        status: SUBSCRIPTION_STATUS.ACTIVE,
        provider: SUBSCRIPTION_PROVIDER.POLAR,
        providerSubscriptionId: checkoutId,
        price: planConfig.price,
        currency: planConfig.currency,
        tokensPerPeriod: planConfig.tokensPerPeriod,
        currentPeriodStart: new Date(),
        cancelAtPeriodEnd: false,
      });
    }

    if (process.env.POLAR_ACCESS_TOKEN) {
      try {
        const polarClient = getPolarClient();
        const subs = await polarClient.subscriptions.list({ limit: 20 });
        const matchingSub = subs.result.items.find(
          (s) =>
            s.status === "active" &&
            (s.customer?.externalId === user._id.toString() ||
              s.metadata?.userId === user._id.toString() ||
              (user.email && s.customer?.email?.toLowerCase() === user.email.toLowerCase()))
        );

        if (matchingSub) {
          await syncPolarSubscriptionEvent({
            type: "subscription.active",
            data: matchingSub,
          });
        }
      } catch (subErr: any) {
        const isRateLimit =
          subErr?.status === 429 ||
          subErr?.statusCode === 429 ||
          (typeof subErr?.message === "string" && subErr.message.includes("429"));
        if (!isRateLimit) {
          console.warn("[Polar Confirm] Subscription lookup warning:", subErr?.message);
        }
      }
    }
  }

  return await getUserSubscription(userId);
};


