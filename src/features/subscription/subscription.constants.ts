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
    tokensPerPeriod: 100000,
    billingInterval: "month",
  },
} as const;

export type PlanKey = keyof typeof SUBSCRIPTION_PLANS;

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
