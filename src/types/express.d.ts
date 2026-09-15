import type { JWTPayload } from "../features/auth/auth.types.js";

declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

export {};
