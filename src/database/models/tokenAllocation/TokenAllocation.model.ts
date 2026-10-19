import { Schema, model } from "mongoose";
import type { ITokenAllocationDocument } from "./tokenAllocation.interface.js";

const tokenAllocationSchema = new Schema<ITokenAllocationDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    allocationKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    checkoutId: {
      type: String,
      trim: true,
      index: false,
    },
    plan: {
      type: String,
      enum: ["free", "pro", "plus"],
      required: true,
    },
    allocatedTokens: {
      type: Number,
      required: true,
      min: 0,
    },
    provider: {
      type: String,
      enum: ["none", "polar"],
      default: "polar",
      required: true,
    },
    providerSubscriptionId: {
      type: String,
      default: null,
      trim: true,
    },
    periodStart: {
      type: Date,
      default: null,
    },
    periodEnd: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ["APPLIED"],
      default: "APPLIED",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for audit querying user allocations chronologically
tokenAllocationSchema.index({ userId: 1, createdAt: -1 });

// Unique sparse/partial index enforcing that a checkoutId can be allocated at most once
tokenAllocationSchema.index(
  { checkoutId: 1 },
  {
    unique: true,
    partialFilterExpression: { checkoutId: { $type: "string" } },
  }
);

export const TokenAllocation = model<ITokenAllocationDocument>(
  "TokenAllocation",
  tokenAllocationSchema
);
