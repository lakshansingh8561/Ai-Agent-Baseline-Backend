import type { Request, Response } from "express";
import {
  validateEvent,
  WebhookVerificationError,
} from "@polar-sh/sdk/webhooks";

export interface ProcessedWebhookResult {
  eventType: string;
  webhookDeliveryId: string | null;
  providerSubscriptionId: string | null;
  received: boolean;
}

/**
 * Validates and handles incoming Polar webhook events using official @polar-sh/sdk.
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

  let event: any;

  try {
    event = validateEvent(rawBody, headers, secret);
  } catch (error: any) {
    if (error instanceof WebhookVerificationError) {
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

    // Check if it's an SDKValidationError for an unknown or unsupported event type
    // If Polar sends an event type not in the SDK's switch table, the signature
    // was verified successfully by standardwebhooks, but SDK parsing failed on event type.
    const isUnknownEventType =
      error.name === "SDKValidationError" &&
      (error.message?.includes("Unknown event type") ||
        error.rawMessage?.includes("Unknown event type"));

    if (isUnknownEventType) {
      console.info(
        "[Polar Webhook] Acknowledging unsupported/unhandled Polar event type"
      );
      res.status(200).json({
        success: true,
        message: "Webhook event acknowledged (unsupported event type)",
      });
      return;
    }

    // Malformed JSON or schema validation error
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
  // Note: Phase 7B only validates & acknowledges; NO tokens are allocated, TokenWallet is untouched
  switch (event.type) {
    case "subscription.created":
    case "subscription.active":
    case "subscription.updated":
    case "subscription.canceled":
    case "subscription.uncanceled":
    case "subscription.revoked":
    case "subscription.past_due":
      // Acknowledged without mutating TokenWallet
      break;
    default:
      // Non-subscription events (e.g. order.*, customer.*) safely acknowledged
      break;
  }

  res.status(200).json({
    success: true,
    message: "Webhook processed successfully",
    data: {
      eventType: event.type,
      webhookDeliveryId,
      providerSubscriptionId,
      received: true,
    },
  });
};
