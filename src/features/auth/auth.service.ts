import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import mongoose from "mongoose";
import { User } from "../../database/models/user/index.js";
import { TokenWallet } from "../../database/models/tokenWallet/index.js";
import { AUTH_CONSTANTS } from "./auth.constants.js";
import type { JWTPayload } from "./auth.types.js";

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  return secret;
};

const generateToken = (user: {
  id: string;
  role: "user" | "admin";
}): string => {
  const payload: JWTPayload = {
    userId: user.id,
    role: user.role,
  };

  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: AUTH_CONSTANTS.JWT_EXPIRES_IN as SignOptions["expiresIn"],
  });
};

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  plan: "free" | "pro";
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: "user" | "admin";
    plan: "free" | "pro";
  };
}

export class AuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "AuthError";
    this.statusCode = statusCode;
  }
}

export const register = async (input: RegisterInput): Promise<AuthResponse> => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const existingUser = await User.findOne({ email: input.email }).session(session);

    if (existingUser) {
      throw new AuthError("Email is already registered", 409);
    }

    const passwordHash = await bcrypt.hash(input.password, 12);

    const [user] = await User.create(
      [
        {
          name: input.name,
          email: input.email,
          passwordHash,
          role: "user",
          plan: "free",
          isActive: true,
        },
      ],
      { session }
    );

    if (!user) {
      throw new AuthError("Failed to create user", 500);
    }

    await TokenWallet.create(
      [
        {
          userId: user._id,
          balance: 10000,
          totalAllocated: 10000,
          totalUsed: 0,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    const token = generateToken({
      id: user._id.toString(),
      role: user.role,
    });

    return {
      token,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        plan: user.plan,
      },
    };
  } catch (error: any) {
    await session.abortTransaction();

    if (error?.code === 11000) {
      throw new AuthError("Email is already registered", 409);
    }

    throw error;
  } finally {
    await session.endSession();
  }
};

export const login = async (input: LoginInput): Promise<AuthResponse> => {
  const user = await User.findOne({
    email: input.email,
  });

  if (!user) {
    throw new AuthError("Invalid email or password", 401);
  }

  if (!user.isActive) {
    throw new AuthError("User account is inactive", 403);
  }

  const passwordMatches = await bcrypt.compare(
    input.password,
    user.passwordHash
  );

  if (!passwordMatches) {
    throw new AuthError("Invalid email or password", 401);
  }

  const token = generateToken({
    id: user._id.toString(),
    role: user.role,
  });

  return {
    token,
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      plan: user.plan,
    },
  };
};

export const getCurrentUser = async (userId: string): Promise<SafeUser> => {
  const user = await User.findById(userId);

  if (!user) {
    throw new AuthError("User not found", 404);
  }

  if (!user.isActive) {
    throw new AuthError("User account is inactive", 403);
  }

  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    plan: user.plan,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};