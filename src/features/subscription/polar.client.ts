import { Polar } from "@polar-sh/sdk";

let polarClientInstance: Polar | null = null;

/**
 * Returns an instance of the official Polar SDK client.
 * Configured using environment variables:
 * - POLAR_ACCESS_TOKEN
 * - POLAR_ENVIRONMENT ("sandbox" or "production")
 */
export const getPolarClient = (): Polar => {
  if (polarClientInstance) {
    return polarClientInstance;
  }

  const accessToken = process.env.POLAR_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("POLAR_ACCESS_TOKEN is not configured in environment");
  }

  const server =
    process.env.POLAR_ENVIRONMENT === "production" ? "production" : "sandbox";

  polarClientInstance = new Polar({
    accessToken,
    server,
  });

  return polarClientInstance;
};

/**
 * Internal testing helper to inject a mocked Polar client.
 * Pass null to reset to the default production/sandbox client.
 */
export const _setInternalPolarClient = (mockClient: any): void => {
  polarClientInstance = mockClient;
};
