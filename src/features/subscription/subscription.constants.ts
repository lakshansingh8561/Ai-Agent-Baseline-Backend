export const SUBSCRIPTION_PLANS = {
  free: {
    name: "Free",
    plan: "free",
    price: 0,
    currency: "USD",
    tokensPerPeriod: 10000,
    billingInterval: "none",
  },
  pro: {
    name: "Pro",
    plan: "pro",
    price: 6,
    currency: "USD",
    tokensPerPeriod: 50000,
    billingInterval: "month",
  },
  plus: {
    name: "Plus",
    plan: "plus",
    price: 20,
    currency: "USD",
    tokensPerPeriod: 100000,
    billingInterval: "month",
  },
} as const;

export type PlanKey = keyof typeof SUBSCRIPTION_PLANS;

export const PLAN_RANK: Record<string, number> = {
  free: 0,
  pro: 1,
  plus: 2,
};

export const SUBSCRIPTION_STATUS = {
  ACTIVE: "active",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  PAST_DUE: "past_due",
} as const;

export const SUBSCRIPTION_PROVIDER = {
  NONE: "none",
  POLAR: "polar",
} as const;

/**
 * Returns the Polar Product ID configured in environment variables for a given plan.
 */
export const getPolarProductIdForPlan = (plan: "plus" | "pro"): string | null => {
  if (plan === "plus") {
    return process.env.POLAR_PLUS_PRODUCT_ID || null;
  }
  if (plan === "pro") {
    return process.env.POLAR_PRO_PRODUCT_ID || null;
  }
  return null;
};

/**
 * Resolves the internal plan from a verified Polar Product ID.
 * Returns null if the product ID does not match any configured plan.
 */
export const getPlanForPolarProductId = (productId: string): "plus" | "pro" | null => {
  if (!productId) return null;

  const plusId = process.env.POLAR_PLUS_PRODUCT_ID;
  if (plusId && productId === plusId) {
    return "plus";
  }

  const proId = process.env.POLAR_PRO_PRODUCT_ID;
  if (proId && productId === proId) {
    return "pro";
  }

  return null;
};

