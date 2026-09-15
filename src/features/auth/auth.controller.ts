import type { Request, Response } from "express";
import {
  register,
  login,
  getCurrentUser,
  AuthError,
} from "./auth.service.js";
import {
  registerSchema,
  loginSchema,
} from "./auth.validation.js";

export const registerUser = async (
  req: Request,
  res: Response
): Promise<void> => {
  const result = registerSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      success: false,
      message: "Invalid registration data",
      errors: result.error.flatten(),
    });

    return;
  }

  try {
    const data = await register(result.data);

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      data,
    });
  } catch (error: any) {
    console.error("Registration error:", error);

    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    if (error?.code === 11000) {
      res.status(409).json({
        success: false,
        message: "Email is already registered",
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Registration failed",
    });
  }
};

export const loginUser = async (
  req: Request,
  res: Response
): Promise<void> => {
  const result = loginSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      success: false,
      message: "Invalid login data",
      errors: result.error.flatten(),
    });

    return;
  }

  try {
    const data = await login(result.data);

    res.status(200).json({
      success: true,
      message: "Login successful",
      data,
    });
  } catch (error) {
    console.error("Login error:", error);

    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(401).json({
      success: false,
      message: "Invalid email or password",
    });
  }
};

export const getMe = async (
  req: Request,
  res: Response
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return;
  }

  try {
    const user = await getCurrentUser(req.user.userId);

    res.status(200).json({
      success: true,
      data: {
        user,
      },
    });
  } catch (error) {
    console.error("Get current user error:", error);

    if (error instanceof AuthError) {
      res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      message: "Failed to retrieve user information",
    });
  }
};