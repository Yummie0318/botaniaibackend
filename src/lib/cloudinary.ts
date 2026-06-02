// src/lib/cloudinary.ts
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export type CloudinaryUploadResult = {
  public_id:  string;
  secure_url: string;
  url:        string;
  format:     string;
  width:      number;
  height:     number;
  bytes:      number;
  folder?:    string; // optional — Cloudinary does not always return this
};

/**
 * Upload a buffer directly to Cloudinary.
 * Returns the upload result with secure_url ready to store in DB.
 */
export async function uploadToCloudinary(
  buffer:   Buffer,
  options?: {
    folder?:        string;
    public_id?:     string;
    resource_type?: "image" | "video" | "raw" | "auto";
  }
): Promise<CloudinaryUploadResult> {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder:        options?.folder        ?? "botaniai/scans",
      public_id:     options?.public_id     ?? undefined,
      resource_type: options?.resource_type ?? "image" as const,
      transformation: [
        { quality: "auto", fetch_format: "auto" },
      ],
    };

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error || !result) return reject(error ?? new Error("Cloudinary upload failed"));
        resolve({
          public_id:  result.public_id,
          secure_url: result.secure_url,
          url:        result.url,
          format:     result.format,
          width:      result.width,
          height:     result.height,
          bytes:      result.bytes,
          folder:     result.folder,
        });
      }
    );

    uploadStream.end(buffer);
  });
}

/**
 * Delete an asset from Cloudinary by its public_id.
 */
export async function deleteFromCloudinary(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId);
}

export { cloudinary };