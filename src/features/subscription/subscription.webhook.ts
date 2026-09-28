import type { Request, Response } from "express";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

import { syncPolarSubscriptionEvent } from "./subscription.service.js";

export interface ProcessedWebhookResult {
  eventType: string;
  webhookDeliveryId: string | null;
  providerSubscriptionId: string | null;
  received: boolean;
}


/**
 * Validates and handles incoming Polar webhook events using standardwebhooks.
 * Operates directly on the raw unmodified request body to guarantee cryptographic integrity.
 * Strictly decoupled from token allocation; does not modify TokenWallet or token budget.
 */
export const handlePolarWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  const secret = process.env.POLAR_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[Polar Webhook] Missing POLAR_WEBHOOK_SECRET configuration");
    res.status(500).json({
      success: false,
      message: "Webhook secret is not configured",
    });
    return;
  }

  // Extract raw body bytes (from express.raw or verify callback)
  const rawBody: Buffer | string | undefined =
    (req as any).rawBody ||
    (Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === "string"
      ? req.body
      : undefined);

  if (
    !rawBody ||
    (typeof rawBody === "string" && rawBody.trim().length === 0) ||
    (Buffer.isBuffer(rawBody) && rawBody.length === 0)
  ) {
    res.status(400).json({
      success: false,
      message: "Missing webhook payload",
    });
    return;
  }

  // Normalize header keys to lowercase for standardwebhooks compliance
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers[key.toLowerCase()] = value;
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      typeof value[0] === "string"
    ) {
      headers[key.toLowerCase()] = value[0];
    }
  }

  const rawBodyString = Buffer.isBuffer(rawBody)
    ? rawBody.toString("utf-8")
    : typeof rawBody === "string"
    ? rawBody
    : "";

  let event: any;

  try {
    let wh: Webhook;
    try {
      wh = new Webhook(secret);
      event = wh.verify(rawBodyString, headers);
    } catch (whErr: any) {
      if (!secret.startsWith("whsec_")) {
        const base64Secret = Buffer.from(secret, "utf-8").toString("base64");
        const fallbackWh = new Webhook(base64Secret);
        event = fallbackWh.verify(rawBodyString, headers);
      } else {
        throw whErr;
      }
    }

    if (typeof event === "string") {
      event = JSON.parse(event);
    }
  } catch (error: any) {
    if (
      error instanceof WebhookVerificationError ||
      error?.name === "WebhookVerificationError"
    ) {
      console.warn(
        "[Polar Webhook] Signature verification failed:",
        error.message
      );
      res.status(400).json({
        success: false,
        message: "Invalid webhook signature",
      });
      return;
    }

    // Malformed JSON or unexpected verification error
    console.warn("[Polar Webhook] Malformed payload error:", error.message);
    res.status(400).json({
      success: false,
      message: "Malformed webhook payload",
    });
    return;
  }

  // 1. Webhook delivery ID from headers (distinct from Polar resource/subscription ID)
  const webhookDeliveryId = headers["webhook-id"] || null;

  // 2. Polar Subscription ID (from event.data.id, distinctly kept separate from webhook delivery ID)
  const providerSubscriptionId =
    event.data && typeof event.data.id === "string" ? event.data.id : null;

  console.log(`[Polar Webhook] Verified event: ${event.type}`, {
    webhookDeliveryId,
    providerSubscriptionId,
  });

  // Safe event processing for supported subscription lifecycle events
  // Note: Phase 7C synchronizes Subscription and User.plan; strictly zero token allocation, TokenWallet untouched
  let syncResult: any = null;
  const isSubscriptionEvent = [
    "subscription.created",
    "subscription.active",
    "subscription.updated",
    "subscription.canceled",
    "subscription.uncanceled",
    "subscription.revoked",
    "subscription.past_due",
  ].includes(event.type);

  if (isSubscriptionEvent && event.data) {
    try {
      syncResult = await syncPolarSubscriptionEvent(event, webhookDeliveryId);
    } catch (syncError: any) {
      console.error("[Polar Webhook] Subscription synchronization failed:", syncError);
      res.status(500).json({
        success: false,
        message: "Failed to synchronize subscription state",
      });
      return;
    }
  } else {
    res.status(200).json({
      success: true,
      message: "Webhook event acknowledged (unsupported event type)",
      data: {
        eventType: event.type,
        webhookDeliveryId,
        providerSubscriptionId,
        received: true,
      },
    });
    return;
  }

  res.status(200).json({
    success: true,
    message: syncResult?.message || "Webhook processed successfully",
    data: {
      eventType: event.type,
      webhookDeliveryId,
      providerSubscriptionId,
      received: true,
      syncResult,
    },
  });
};

