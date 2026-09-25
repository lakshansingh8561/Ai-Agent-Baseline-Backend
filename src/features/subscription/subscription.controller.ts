import type { Request, Response } from "express";
import {
  getUserSubscription,
  createCheckoutSession,
  createProCheckoutSession,
  getSubscriptionCatalog,
  SubscriptionError,
} from "./subscription.service.js";
import { createCheckoutSchema } from "./subscription.dto.js";

/**
 * Public catalog endpoint exposing configured plans (Free, Plus, Pro)
 * with strict prices ($0, $6, $20) and no credentials.
 */
export const getSubscriptionCatalogHandler = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const plans = getSubscriptionCatalog();
    res.status(200).json({
      success: true,
      message: "Subscription catalog retrieved successfully",
      data: {
        plans,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: "Failed to retrieve subscription catalog",
    });
  }
};

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
 * Handles creation of a Polar Checkout Session (Plus or Pro).
 * Strictly requires authentication and derives identity from req.user.userId.
 */
export const createCheckoutSessionHandler = async (
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

  const parseResult = createCheckoutSchema.safeParse(req.body || {});
  if (!parseResult.success) {
    res.status(400).json({
      success: false,
      message: "Invalid checkout plan requested",
      errors: parseResult.error.flatten(),
    });
    return;
  }

  try {
    const targetPlan = parseResult.data.plan ?? "pro";
    const clientOrigin =
      (req.headers.origin as string) ||
      (typeof req.headers.referer === "string" ? new URL(req.headers.referer).origin : undefined);

    const checkoutSession = await createCheckoutSession(
      req.user.userId,
      targetPlan,
      clientOrigin
    );

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

/**
 * On-demand confirmation of Polar checkout return.
 * Reconciles with Polar API immediately without waiting for webhook delivery.
 */
export const confirmCheckoutSessionHandler = async (
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

  const checkoutId = req.body?.checkoutId || req.query?.checkoutId || req.query?.checkout_id;
  if (!checkoutId || typeof checkoutId !== "string") {
    res.status(400).json({
      success: false,
      message: "Missing checkoutId parameter",
    });
    return;
  }

  try {
    const { confirmCheckoutSession } = await import("./subscription.service.js");
    const subscription = await confirmCheckoutSession(req.user.userId, checkoutId);

    res.status(200).json({
      success: true,
      message: "Checkout confirmed and subscription updated successfully",
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
      message: "Failed to confirm checkout session",
    });
  }
};

export const createProCheckoutSessionHandler = createCheckoutSessionHandler;

