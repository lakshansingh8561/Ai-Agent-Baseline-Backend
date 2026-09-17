import { Schema, model } from "mongoose";
import type { ISubscriptionDocument } from "./subscription.interface.js";

const subscriptionSchema = new Schema<ISubscriptionDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    plan: {
      type: String,
      enum: ["free", "pro"],
      default: "free",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "cancelled", "expired", "past_due"],
      default: "active",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ["none", "polar"],
      default: "none",
      required: true,
    },
    providerSubscriptionId: {
      type: String,
      default: null,
    },
    providerProductId: {
      type: String,
      default: null,
    },
    price: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "USD",
      required: true,
    },
    tokensPerPeriod: {
      type: Number,
      required: true,
    },
    currentPeriodStart: {
      type: Date,
      default: Date.now,
      required: true,
    },
    currentPeriodEnd: {
      type: Date,
      default: null,
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
      required: true,
    },
    lastWebhookEventId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for active user subscription lookup
subscriptionSchema.index({ userId: 1, status: 1 });

// Unique sparse index for Polar subscription idempotency & lookup
subscriptionSchema.index(
  { providerSubscriptionId: 1 },
  { unique: true, sparse: true }
);

export const Subscription = model<ISubscriptionDocument>(
  "Subscription",
  subscriptionSchema
);

