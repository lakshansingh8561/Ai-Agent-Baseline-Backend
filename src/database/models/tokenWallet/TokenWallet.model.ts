import { Schema, model } from "mongoose";
import type { ITokenWalletDocument } from "./tokenWallet.interface.js";

const tokenWalletSchema = new Schema<ITokenWalletDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    balance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    totalAllocated: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    totalUsed: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

export const TokenWallet = model<ITokenWalletDocument>(
  "TokenWallet",
  tokenWalletSchema
);