import type { Types } from "mongoose";

export interface AuthenticatedUser {
  userId: Types.ObjectId;
  role: "user" | "admin";
}

export interface JWTPayload {
  userId: string;
  role: "user" | "admin";
}