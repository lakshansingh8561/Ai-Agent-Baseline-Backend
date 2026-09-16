import type { Request, Response } from "express";
import { getUserTokenBalance } from "./token.service.js";
import { TokenError, TokenWalletNotFoundError } from "./token.errors.js";

export const getTokenBalanceHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return;
  }

  try {
    // Strictly use authenticated JWT user ID; never accept from params, body, or query
    const balance = await getUserTokenBalance(req.user.userId);

    res.status(200).json({
      success: true,
      message: "Token balance retrieved successfully",
      data: balance,
    });
  } catch (error: any) {
    if (error instanceof TokenWalletNotFoundError) {
      res.status(404).json({
        success: false,
        message: error.message || "Token wallet not found",
      });
      return;
    }

    if (error instanceof TokenError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to retrieve token balance",
    });
  }
};
