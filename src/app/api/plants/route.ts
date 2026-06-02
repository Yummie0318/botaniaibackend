// src/app/api/plants/route.ts
import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit    = Math.min(Number(searchParams.get("limit")  || 50), 100);
    const offset   = Number(searchParams.get("offset") || 0);
    const category = searchParams.get("category") || null;
    const q        = (searchParams.get("q") || "").trim();

    let whereClause = `WHERE ps.deleted_at IS NULL`;
    const queryParams: unknown[] = [];
    let paramIndex = 1;

    if (q) {
      whereClause += ` AND (
        ps.common_name    ILIKE $${paramIndex}
        OR ps.scientific_name ILIKE $${paramIndex}
        OR ps.local_name      ILIKE $${paramIndex}
        OR ps.search_text     ILIKE $${paramIndex}
      )`;
      queryParams.push(`%${q}%`);
      paramIndex++;
    }

    if (category) {
      whereClause += ` AND ps.category = $${paramIndex}`;
      queryParams.push(category);
      paramIndex++;
    }

    queryParams.push(limit);
    queryParams.push(offset);

    // ── Main query — joins to scan_images to get a representative image
    //    and counts total sightings across all users ────────────────────
    const result = await pool.query(
      `
      SELECT
        ps.id,
        ps.common_name,
        ps.scientific_name,
        ps.local_name,
        ps.family_name,
        ps.genus_name,
        ps.category,
        ps.edible_status,
        ps.medicinal_status,
        ps.toxicity_status,
        ps.pet_safety_status,
        ps.description_short,
        ps.confidence_source,
        ps.created_at,

        -- Representative image: prefer plant_media, fall back to a scan image
        COALESCE(
          (
            SELECT pm.url
            FROM plant_media pm
            WHERE pm.plant_species_id = ps.id
            ORDER BY pm.is_primary DESC, pm.sort_order ASC
            LIMIT 1
          ),
          (
            SELECT ma.public_url
            FROM scan_identifications si
            JOIN scans s        ON s.id  = si.scan_id
            JOIN scan_images simg ON simg.scan_id = s.id
            JOIN media_assets ma  ON ma.id = simg.media_asset_id
            WHERE si.plant_species_id = ps.id
              AND si.is_primary = TRUE
              AND s.status = 'completed'
            ORDER BY si.confidence_score DESC, simg.sort_order ASC
            LIMIT 1
          )
        ) AS image_url,

        -- How many times this species has been identified across all users
        (
          SELECT COUNT(*)::int
          FROM scan_identifications si2
          WHERE si2.plant_species_id = ps.id
            AND si2.is_primary = TRUE
        ) AS sighting_count

      FROM plant_species ps
      ${whereClause}
      ORDER BY ps.common_name ASC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `,
      queryParams
    );

    // ── Count query (no image subquery needed) ────────────────────────
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM plant_species ps ${whereClause}`,
      queryParams.slice(0, -2)
    );

    return ok({
      plants: result.rows,
      total:  countResult.rows[0].total,
      limit,
      offset,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch plants.", 400);
  }
}