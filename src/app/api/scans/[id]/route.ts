import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    const scanResult = await pool.query(
      `
      SELECT
        s.*,
        m.public_url AS image_url
      FROM scans s
      LEFT JOIN media_assets m ON m.id = s.image_asset_id
      WHERE s.id = $1 AND s.user_id = $2
      LIMIT 1
      `,
      [id, user.id]
    );

    if (scanResult.rows.length === 0) {
      return fail("Scan not found.", 404);
    }

    const scan = scanResult.rows[0];

    const scanImagesResult = await pool.query(
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

    const identificationsResult = await pool.query(
      `
      SELECT *
      FROM scan_identifications
      WHERE scan_id = $1
      ORDER BY rank_order ASC, confidence_score DESC
      `,
      [id]
    );

    const identifications = identificationsResult.rows;

    for (const item of identifications) {
      if (!item.plant_species_id || !scan.country_code) continue;

      const localNameResult = await pool.query(
        `
        SELECT name, language_code, country_code
        FROM plant_common_names
        WHERE plant_species_id = $1
          AND country_code = $2
        ORDER BY is_primary DESC, name ASC
        LIMIT 1
        `,
        [item.plant_species_id, scan.country_code]
      );

      if (localNameResult.rows.length > 0) {
        item.localized_name = localNameResult.rows[0].name;
        item.localized_country_code = localNameResult.rows[0].country_code;
        item.localized_language_code = localNameResult.rows[0].language_code;
      }
    }

    const diagnoses = await pool.query(
      `
      SELECT *
      FROM scan_diagnoses
      WHERE scan_id = $1
      ORDER BY rank_order ASC, confidence_score DESC
      `,
      [id]
    );

    return ok({
      scan,
      scan_images: scanImagesResult.rows,
      identifications,
      diagnoses: diagnoses.rows,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch scan.", 400);
  }
}