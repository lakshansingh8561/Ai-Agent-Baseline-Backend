import type { Request, Response } from "express";
import {
  getUserSubscription,
  createProCheckoutSession,
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

/**
 * Handles creation of a Polar Pro Checkout Session.
 * Strictly requires authentication and derives identity from req.user.userId.
 */
export const createProCheckoutSessionHandler = async (
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
    // Strictly derive userId from req.user.userId; never accept from body or params
    const checkoutSession = await createProCheckoutSession(req.user.userId);

    res.status(200).json({
      success: true,
      message: "Checkout session created successfully",
      data: checkoutSession,
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
      message: error.message || "Failed to create checkout session",
    });
  }
};

