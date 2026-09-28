import { Readable } from "node:stream";
import type { UploadApiResponse } from "cloudinary";
import cloudinary from "../../config/cloudinary.js";

export const CLOUDINARY_CHAT_FOLDER = "Ai-Agent";

export interface CloudinaryUploadResult {
  secureUrl: string;
  publicId: string;
  format: string;
  bytes: number;
  resourceType: string;
}

/**
 * Uploads an in-memory image buffer directly to Cloudinary in the "Ai-Agent" folder.
 */
export const uploadChatImage = async (
  buffer: Buffer,
  originalFilename: string,
  _mimeType?: string
): Promise<CloudinaryUploadResult> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: CLOUDINARY_CHAT_FOLDER,
        resource_type: "image",
        filename_override: originalFilename,
        use_filename: false,
        unique_filename: true,
      },
      (error, result?: UploadApiResponse) => {
        if (error || !result) {
          console.error("[Cloudinary] Upload failed:", error);
          return reject(
            new Error(
              error?.message || "Failed to upload image to Cloudinary"
            )
          );
        }

        resolve({
          secureUrl: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          bytes: result.bytes,
          resourceType: result.resource_type,
        });
      }
    );

    const readable = Readable.from(buffer);
    readable.pipe(uploadStream);
  });
};

/**
 * Deletes an image from Cloudinary by its publicId.
 * Never throws to avoid failing parent deletion transactions; returns boolean success.
 */
export const deleteChatImage = async (publicId: string): Promise<boolean> => {
  if (!publicId) return false;
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: "image",
      invalidate: true,
    });
    return result?.result === "ok" || result?.result === "not found";
  } catch (error) {
    console.error(`[Cloudinary] Failed to delete image ${publicId}:`, error);
    return false;
  }
};
