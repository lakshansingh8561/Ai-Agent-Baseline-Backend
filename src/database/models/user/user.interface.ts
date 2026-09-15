import type { Document } from "mongoose";

export type UserRole = "user" | "admin";

export type UserPlan = "free" | "pro";

export interface IUser {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  plan: UserPlan;
  isActive: boolean;
}

export interface IUserDocument extends IUser, Document {
  createdAt: Date;
  updatedAt: Date;
}