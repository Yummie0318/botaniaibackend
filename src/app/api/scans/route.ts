import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const body = await request.json();

    const {
      image_asset_id,
      scan_type = "identify",
      source = "camera",
      latitude = null,
      longitude = null,
      country_code = null,
      region_name = null,
      city_name = null,
      metadata = {},
    } = body;

    if (!image_asset_id) {
      return fail("image_asset_id is required.", 400);
    }

    const result = await pool.query(
      `
      INSERT INTO scans (
        user_id,
        image_asset_id,
        scan_type,
        status,
        source,
        latitude,
        longitude,
        country_code,
        region_name,
        city_name,
        captured_at,
        metadata
      )
      VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, NOW(), $10)
      RETURNING *
      `,
      [
        user.id,
        image_asset_id,
        scan_type,
        source,
        latitude,
        longitude,
        country_code,
        region_name,
        city_name,
        JSON.stringify(metadata),
      ]
    );

    return ok({ scan: result.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to create scan.", 400);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const { searchParams } = new URL(request.url);

    const limit = Math.min(Number(searchParams.get("limit") || 20), 100);
    const offset = Math.max(Number(searchParams.get("offset") || 0), 0);

const result = await pool.query(
      `
      SELECT
        s.id,
        s.scan_type,
        s.status,
        s.source,
        s.created_at,
        s.completed_at,
        m.public_url AS image_url,
        CASE
          WHEN s.scan_type = 'disease' THEN sd.diagnosis_name
          ELSE si.predicted_common_name
        END AS predicted_common_name,
        CASE
          WHEN s.scan_type = 'disease' THEN sd.diagnosis_type
          ELSE si.predicted_scientific_name
        END AS predicted_scientific_name,
        CASE
          WHEN s.scan_type = 'disease' THEN sd.confidence_score
          ELSE si.confidence_score
        END AS confidence_score,
        s.scan_type = 'disease' AS is_disease
      FROM scans s
      LEFT JOIN media_assets m ON m.id = s.image_asset_id
      LEFT JOIN scan_identifications si
        ON si.scan_id = s.id AND si.is_primary = TRUE
      LEFT JOIN scan_diagnoses sd
        ON sd.scan_id = s.id AND sd.rank_order = 1
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [user.id, limit, offset]
    );

    return ok({ scans: result.rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch scans.", 400);
  }
}