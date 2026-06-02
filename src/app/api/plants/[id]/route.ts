// src/app/api/plants/[id]/route.ts
import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;

    // ── Run all queries in parallel for speed ─────────────────────────
    const [
      plantResult,
      commonNames,
      benefits,
      careGuide,
      media,
      scanImages,
      sightingCount,
    ] = await Promise.all([

      // Plant base data
      pool.query(
        `SELECT * FROM plant_species WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [id]
      ),

      // Localized names
      pool.query(
        `
        SELECT id, language_code, country_code, name, is_primary
        FROM plant_common_names
        WHERE plant_species_id = $1
        ORDER BY is_primary DESC, name ASC
        `,
        [id]
      ),

      // Benefits
      pool.query(
        `
        SELECT id, benefit_type, title, description, evidence_level, caution_notes
        FROM plant_benefits
        WHERE plant_species_id = $1
        ORDER BY created_at ASC
        `,
        [id]
      ),

      // Care guide
      pool.query(
        `SELECT * FROM plant_care_guides WHERE plant_species_id = $1 LIMIT 1`,
        [id]
      ),

      // Curated media (plant_media table)
      pool.query(
        `
        SELECT id, media_type, url, alt_text, is_primary, sort_order
        FROM plant_media
        WHERE plant_species_id = $1
        ORDER BY is_primary DESC, sort_order ASC
        `,
        [id]
      ),

      // ── User scan images for this species ──────────────────────────
      // Up to 12 unique images from real user scans, best confidence first
      pool.query(
        `
        SELECT DISTINCT ON (s.user_id)
          ma.public_url   AS image_url,
          ma.mime_type,
          simg.image_role,
          si.confidence_score,
          s.user_id
        FROM scan_identifications si
        JOIN scans s          ON s.id   = si.scan_id
        JOIN scan_images simg ON simg.scan_id = s.id
        JOIN media_assets ma  ON ma.id  = simg.media_asset_id
        WHERE si.plant_species_id = $1
          AND si.is_primary = TRUE
          AND s.status = 'completed'
          AND ma.public_url IS NOT NULL
        ORDER BY s.user_id, si.confidence_score DESC, simg.sort_order ASC
        LIMIT 12
        `,
        [id]
      ),

      // Total unique users who have scanned this species
      pool.query(
        `
        SELECT
          COUNT(*)::int                          AS total_sightings,
          COUNT(DISTINCT s.user_id)::int         AS unique_scanners
        FROM scan_identifications si
        JOIN scans s ON s.id = si.scan_id
        WHERE si.plant_species_id = $1
          AND si.is_primary = TRUE
          AND s.status = 'completed'
        `,
        [id]
      ),
    ]);

    if (plantResult.rows.length === 0) return fail("Plant not found.", 404);

    return ok({
      plant:        plantResult.rows[0],
      common_names: commonNames.rows,
      benefits:     benefits.rows,
      care_guide:   careGuide.rows[0] || null,

      // Curated media first, then real scan images
      media:        media.rows,
      scan_images:  scanImages.rows,

      // Stats
      sighting_count:  sightingCount.rows[0].total_sightings,
      unique_scanners: sightingCount.rows[0].unique_scanners,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch plant.", 400);
  }
}