import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import type { Request, Response, NextFunction } from "express";

// Ensure upload directory exists
export const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// 10MB maximum file size limit
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported image format (${file.mimetype}). Please upload JPG, PNG, WEBP, or GIF.`));
    }
  },
});

/**
 * Express middleware to handle optional single image upload.
 * Transparently supports both multipart/form-data and application/json requests.
 */
export const chatUploadMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  upload.single("image")(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(400).json({
            success: false,
            message: `Image exceeds maximum allowed size of ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`,
          });
          return;
        }
        res.status(400).json({
          success: false,
          message: err.message || "File upload error",
        });
        return;
      }

      res.status(400).json({
        success: false,
        message: err.message || "Invalid file upload",
      });
      return;
    }
    next();
  });
};
