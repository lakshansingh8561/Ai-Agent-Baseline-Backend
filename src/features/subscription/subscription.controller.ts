import type { Request, Response } from "express";
import {
  getUserSubscription,
  SubscriptionError,
} from "./subscription.service.js";

export const getUserSubscriptionHandler = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user || !req.user.userId) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return;
  }

  try {
    // Strictly derive userId from authenticated JWT payload; ignore URL, query, or body
    const subscription = await getUserSubscription(req.user.userId);

    res.status(200).json({
      success: true,
      message: "Subscription retrieved successfully",
      data: subscription,
    });
  } catch (error: any) {
    if (error instanceof SubscriptionError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to retrieve subscription information",
    });
  }
};
