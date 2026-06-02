import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

// GET /api/biodiversity/map
// Returns sightings aggregated into geographic grid cells.
// Each cell represents ~11km² and shows unique species count (biodiversity richness)
// + a species list for the detail panel.
// No auth required — public data.

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const species_id = searchParams.get("species_id") || null;
    const category   = searchParams.get("category")   || null;
    const limit      = Math.min(Number(searchParams.get("limit") || 500), 1000);
    const grid_size  = Math.min(Math.max(Number(searchParams.get("grid_size") || 0.1), 0.005), 2);
    // ── Main query: aggregate scans into grid cells ──────────────────────────
    // Each row = one cell with:
    //   • unique_species  — how many distinct species were spotted here
    //   • total_sightings — raw scan count
    //   • species_list    — JSON array of species in this cell (for detail panel)
    //   • latitude/longitude — centroid of all scans in the cell
    const result = await pool.query(
      `
      WITH base AS (
        -- All completed scans with a confirmed species, within optional filters
        SELECT
          s.id                                                      AS scan_id,
          s.latitude,
          s.longitude,
          s.country_code,
          s.region_name,
          s.city_name,
          -- Snap each scan to its grid cell
          ROUND(s.latitude::numeric  / $4::numeric, 4) * $4::numeric AS cell_lat,
          ROUND(s.longitude::numeric / $4::numeric, 4) * $4::numeric AS cell_lng,
          ps.id             AS species_id,
          ps.common_name,
          ps.scientific_name,
          ps.category,
          ps.toxicity_status,
          ps.edible_status,
          ma.public_url AS image_url
        FROM scans s
        JOIN scan_identifications si
          ON si.scan_id = s.id AND si.is_primary = TRUE
        JOIN plant_species ps
          ON ps.id = si.plant_species_id
        LEFT JOIN scan_images simg
          ON simg.scan_id = s.id
          AND simg.sort_order = (
            SELECT MIN(sort_order) FROM scan_images WHERE scan_id = s.id
          )
        LEFT JOIN media_assets ma ON ma.id = simg.media_asset_id
        WHERE
          s.latitude  IS NOT NULL
          AND s.longitude IS NOT NULL
          AND s.status = 'completed'
          AND si.plant_species_id IS NOT NULL
          AND ($1::uuid IS NULL OR ps.id    = $1::uuid)
          AND ($2::text IS NULL OR ps.category = $2::text)
      ),

        species_per_cell AS (
        -- Count how many times each species appears per cell
        -- Also grab one representative image (most recent scan that has one)
        SELECT DISTINCT ON (cell_lat, cell_lng, species_id)
          cell_lat,
          cell_lng,
          species_id,
          common_name,
          scientific_name,
          category,
          toxicity_status,
          edible_status,
          image_url,
          COUNT(*) OVER (
            PARTITION BY cell_lat, cell_lng, species_id
          ) AS sighting_count
        FROM base
        WHERE image_url IS NOT NULL  -- prefer rows that have an image
        UNION ALL
        -- Fallback: include species that have no image at all
        SELECT DISTINCT ON (cell_lat, cell_lng, species_id)
          cell_lat,
          cell_lng,
          species_id,
          common_name,
          scientific_name,
          category,
          toxicity_status,
          edible_status,
          NULL AS image_url,
          COUNT(*) OVER (
            PARTITION BY cell_lat, cell_lng, species_id
          ) AS sighting_count
        FROM base b
        WHERE NOT EXISTS (
          SELECT 1 FROM base b2
          WHERE b2.cell_lat   = b.cell_lat
            AND b2.cell_lng   = b.cell_lng
            AND b2.species_id = b.species_id
            AND b2.image_url IS NOT NULL
        )
      )

      SELECT
        spc.cell_lat,
        spc.cell_lng,
        -- Centroid of all scans in the cell
        AVG(b.latitude)   AS latitude,
        AVG(b.longitude)  AS longitude,
        -- Biodiversity metrics
        COUNT(DISTINCT spc.species_id)  AS unique_species,
        COUNT(b.scan_id)                AS total_sightings,
        -- Most common location label for display
        MODE() WITHIN GROUP (ORDER BY b.country_code) AS country_code,
        MODE() WITHIN GROUP (ORDER BY b.region_name)  AS region_name,
        MODE() WITHIN GROUP (ORDER BY b.city_name)    AS city_name,
        -- Species list for the detail panel, sorted by sighting count desc
        JSON_AGG(
          JSONB_BUILD_OBJECT(
            'species_id',      spc.species_id,
            'common_name',     spc.common_name,
            'scientific_name', spc.scientific_name,
            'category',        spc.category,
            'toxicity_status', spc.toxicity_status,
            'edible_status',   spc.edible_status,
            'sighting_count',  spc.sighting_count,
            'image_url',       spc.image_url
          )
          ORDER BY spc.sighting_count DESC
        ) AS species_list
      FROM species_per_cell spc
      JOIN base b
        ON b.cell_lat = spc.cell_lat
        AND b.cell_lng = spc.cell_lng
      GROUP BY spc.cell_lat, spc.cell_lng
      ORDER BY unique_species DESC
      LIMIT $3
      `,
      [species_id, category, limit, grid_size]
    );

    // ── Species summary (unchanged — used for filter sidebar) ────────────────
    const speciesSummary = await pool.query(
      `
      SELECT
        ps.id            AS species_id,
        ps.common_name,
        ps.scientific_name,
        ps.category,
        COUNT(s.id)      AS sighting_count
      FROM scans s
      JOIN scan_identifications si
        ON si.scan_id = s.id AND si.is_primary = TRUE
      JOIN plant_species ps
        ON ps.id = si.plant_species_id
      WHERE
        s.latitude  IS NOT NULL
        AND s.longitude IS NOT NULL
        AND s.status = 'completed'
        AND si.plant_species_id IS NOT NULL
      GROUP BY ps.id, ps.common_name, ps.scientific_name, ps.category
      ORDER BY sighting_count DESC
      LIMIT 50
      `
    );

    return ok({
      cells:           result.rows,
      total_cells:     result.rows.length,
      species_summary: speciesSummary.rows,
    });
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Failed to fetch map data.",
      400
    );
  }
}