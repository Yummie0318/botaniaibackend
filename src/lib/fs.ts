// src/lib/fs.ts
// Local storage kept for backward compatibility with existing local images.
// New uploads go to Cloudinary — this file is no longer used for new uploads.

import fs from "fs/promises";
import path from "path";

export const IMAGE_STORAGE_DIR = path.join(process.cwd(), "public", "storage", "image");

export async function ensureImageStorageDir() {
  await fs.mkdir(IMAGE_STORAGE_DIR, { recursive: true });
}

export function getPublicImageUrl(filename: string) {
  return `/storage/image/${filename}`;
}