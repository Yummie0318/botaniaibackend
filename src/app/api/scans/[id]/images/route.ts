import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = {
  params: Promise<{ id: string }>;
};

function normalizeImageRole(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();

  const allowed = new Set([
    "general",
    "whole_plant",
    "leaf_closeup",
    "bark",
    "flower",
    "fruit",
  ]);

  if (allowed.has(raw)) return raw;
  return "general";
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const body = await request.json();

    const mediaAssetId = String(body.media_asset_id || "").trim();
    const imageRole = normalizeImageRole(body.image_role);

    if (!mediaAssetId) {
      return fail("media_asset_id is required.", 400);
    }

    const scanResult = await pool.query(
      `
      SELECT id, user_id
      FROM scans
      WHERE id = $1 AND user_id = $2
      LIMIT 1
      `,
      [id, user.id]
    );

    if (scanResult.rows.length === 0) {
      return fail("Scan not found.", 404);
    }

    const assetResult = await pool.query(
      `
      SELECT id, owner_user_id, public_url, mime_type
      FROM media_assets
      WHERE id = $1
      LIMIT 1
      `,
      [mediaAssetId]
    );

    if (assetResult.rows.length === 0) {
      return fail("Media asset not found.", 404);
    }

    const asset = assetResult.rows[0];

    if (asset.owner_user_id && asset.owner_user_id !== user.id) {
      return fail("You do not have access to this media asset.", 403);
    }

    const sortResult = await pool.query(
      `
      SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
      FROM scan_images
      WHERE scan_id = $1
      `,
      [id]
    );

    const nextSortOrder = Number(sortResult.rows[0]?.max_sort_order || 0) + 1;

    const inserted = await pool.query(
      `
      INSERT INTO scan_images (
        scan_id,
        media_asset_id,
        image_role,
        sort_order
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [id, mediaAssetId, imageRole, nextSortOrder]
    );

    const allImages = await pool.query(
      `
      SELECT
        si.id,
        si.scan_id,
        si.media_asset_id,
        si.image_role,
        si.sort_order,
        si.created_at,
        ma.public_url,
        ma.mime_type
      FROM scan_images si
      JOIN media_assets ma ON ma.id = si.media_asset_id
      WHERE si.scan_id = $1
      ORDER BY si.sort_order ASC, si.created_at ASC
      `,
      [id]
    );

    return ok(
      {
        scan_image: inserted.rows[0],
        images: allImages.rows,
      },
      201
    );
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Failed to attach image to scan.",
      400
    );
  }
}