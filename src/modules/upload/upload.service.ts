import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { pool } from "@/lib/db";
import {
  ensureImageStorageDir,
  getPublicImageUrl,
  IMAGE_STORAGE_DIR,
} from "@/lib/fs";

function getExtensionFromMime(mimeType: string) {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".bin";
  }
}

export async function saveUploadedImage(input: {
  ownerUserId: string;
  file: File;
}) {
  const { ownerUserId, file } = input;

  if (!file.type.startsWith("image/")) {
    throw new Error("Only image uploads are allowed.");
  }

  await ensureImageStorageDir();

  const ext = getExtensionFromMime(file.type);
  const filename = `${Date.now()}-${randomUUID()}${ext}`;
  const filepath = path.join(IMAGE_STORAGE_DIR, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filepath, buffer);

  const publicUrl = getPublicImageUrl(filename);

  const result = await pool.query(
    `
    INSERT INTO media_assets (
      owner_user_id,
      storage_provider,
      original_filename,
      mime_type,
      file_size_bytes,
      public_url,
      metadata
    )
    VALUES ($1, 'local', $2, $3, $4, $5, $6)
    RETURNING id, owner_user_id, public_url, mime_type, file_size_bytes, created_at
    `,
    [
      ownerUserId,
      file.name,
      file.type,
      file.size,
      publicUrl,
      JSON.stringify({ local_filename: filename }),
    ]
  );

  return result.rows[0];
}