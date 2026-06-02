import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

// GET /api/streaks/species — all unique species the user has ever identified
export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);

    const result = await pool.query(
      `
      SELECT DISTINCT ON (ps.id)
        ps.id,
        ps.common_name,
        ps.scientific_name,
        ps.family_name,
        ps.category,
        ps.description_short,
        ps.edible_status,
        ps.toxicity_status,
        ma.public_url AS image_url,
        MIN(s.created_at) AS first_discovered_at
      FROM scan_identifications si
      JOIN scans s ON s.id = si.scan_id
      JOIN plant_species ps ON ps.id = si.plant_species_id
      LEFT JOIN scan_images simg ON simg.scan_id = s.id
        AND simg.sort_order = (
          SELECT MIN(sort_order) FROM scan_images WHERE scan_id = s.id
        )
      LEFT JOIN media_assets ma ON ma.id = simg.media_asset_id
      WHERE s.user_id = $1
        AND si.is_primary = TRUE
        AND si.plant_species_id IS NOT NULL
      GROUP BY ps.id, ps.common_name, ps.scientific_name,
               ps.family_name, ps.category, ps.description_short,
               ps.edible_status, ps.toxicity_status, ma.public_url
      ORDER BY ps.id, first_discovered_at ASC
      `,
      [user.id]
    );

    return ok({
      species: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch species.", 400);
  }
}