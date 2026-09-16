import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { JWTPayload } from "../../features/auth/auth.types.js";

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      success: false,
      message: "Authorization header is required",
    });
    return;
  }

  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      message: "Invalid authorization format. Format must be 'Bearer <token>'",
    });
    return;
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    res.status(401).json({
      success: false,
      message: "Authentication token is missing",
    });
    return;
  }

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    res.status(500).json({
      success: false,
      message: "Server configuration error",
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload;

    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof decoded.userId !== "string" ||
      (decoded.role !== "user" && decoded.role !== "admin")
    ) {
      res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
      return;
    }

    req.user = {
      userId: decoded.userId,
      role: decoded.role,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        message: "Token has expired",
      });
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
      return;
    }

    res.status(401).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

export const authenticate = authMiddleware;
export default authMiddleware;
