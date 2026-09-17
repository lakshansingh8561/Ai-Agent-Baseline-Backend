import mongoose, { type ClientSession } from "mongoose";
import { Subscription } from "../../database/models/subscription/index.js";
import { User } from "../../database/models/user/index.js";
import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PROVIDER,
  type PlanKey,
} from "./subscription.constants.js";
import type { SafeSubscription } from "./subscription.dto.js";

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

  // 1. Query for active subscription document
  const activeSub = await Subscription.findOne({
    userId: userObjectId,
    status: SUBSCRIPTION_STATUS.ACTIVE,
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
