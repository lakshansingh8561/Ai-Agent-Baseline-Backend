import { z } from "zod";
import { AUTH_CONSTANTS } from "./auth.constants.js";

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name is too long"),

  email: z
    .string()
    .trim()
    .email("Invalid email address")
    .transform((email) => email.toLowerCase()),

  password: z
    .string()
    .min(
      AUTH_CONSTANTS.MIN_PASSWORD_LENGTH,
      `Password must be at least ${AUTH_CONSTANTS.MIN_PASSWORD_LENGTH} characters`
    )
    .max(
      AUTH_CONSTANTS.MAX_PASSWORD_LENGTH,
      `Password must not exceed ${AUTH_CONSTANTS.MAX_PASSWORD_LENGTH} characters`
    ),
});

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email("Invalid email address")
    .transform((email) => email.toLowerCase()),

  password: z.string().min(1, "Password is required"),
});