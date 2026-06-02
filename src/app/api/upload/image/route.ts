// src/app/api/upload/image/route.ts
import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { fail, ok } from "@/lib/response";

export const runtime = "nodejs";

function getExtensionFromMime(mimeType: string) {
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/png":  return ".png";
    case "image/webp": return ".webp";
    case "image/heic": return ".heic";
    case "image/heif": return ".heif";
    default:           return ".bin";
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request);

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return fail("Image file is required.", 400);
    }

    if (!file.type.startsWith("image/")) {
      return fail("Only image uploads are allowed.", 400);
    }

    // Convert to buffer
    const buffer = Buffer.from(await file.arrayBuffer());

    // Build a unique public_id for Cloudinary
    const assetId  = randomUUID();
    const publicId = `botaniai/scans/${user.id}/${assetId}`;

    // Upload to Cloudinary
    const uploaded = await uploadToCloudinary(buffer, {
      folder:    "botaniai/scans",
      public_id: publicId,
    });

    // Save to DB
    const inserted = await pool.query(
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
      VALUES ($1, 'cloudinary', $2, $3, $4, $5, $6)
      RETURNING id, public_url, mime_type, file_size_bytes, created_at
      `,
      [
        user.id,
        file.name,
        file.type,
        file.size,
        uploaded.secure_url,
        JSON.stringify({
          cloudinary_public_id: uploaded.public_id,
          cloudinary_url:       uploaded.secure_url,
          width:                uploaded.width,
          height:               uploaded.height,
          format:               uploaded.format,
          bytes:                uploaded.bytes,
          storage:              "cloudinary",
        }),
      ]
    );

    return ok({ asset: inserted.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Upload failed.", 400);
  }
}