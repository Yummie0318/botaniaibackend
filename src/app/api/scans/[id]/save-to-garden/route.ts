import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: scanId } = await params;
    const body = await request.json();

    // Get the scan + its primary identification
    const scanResult = await pool.query(
      `
      SELECT
        s.id,
        s.user_id,
        si.plant_species_id,
        si.predicted_common_name,
        si.predicted_scientific_name
      FROM scans s
      LEFT JOIN scan_identifications si
        ON si.scan_id = s.id AND si.is_primary = TRUE
      WHERE s.id = $1 AND s.user_id = $2
      LIMIT 1
      `,
      [scanId, user.id]
    );

    if (scanResult.rows.length === 0) return fail("Scan not found.", 404);

    const scan = scanResult.rows[0];

    if (!scan.plant_species_id) {
      return fail("This scan has no confirmed plant identification yet.", 400);
    }

    // Use provided garden_id or find/create a default garden
    let gardenId = typeof body.garden_id === "string" ? body.garden_id : null;

    if (!gardenId) {
      const gardenResult = await pool.query(
        `SELECT id FROM gardens WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [user.id]
      );

      if (gardenResult.rows.length > 0) {
        gardenId = gardenResult.rows[0].id;
      } else {
        // Auto-create a default garden if user has none
        const newGarden = await pool.query(
          `
          INSERT INTO gardens (user_id, name, is_indoor)
          VALUES ($1, 'My Garden', false)
          RETURNING id
          `,
          [user.id]
        );
        gardenId = newGarden.rows[0].id;
      }
    }

    // Check if already in this garden
    const duplicate = await pool.query(
      `
      SELECT id FROM garden_plants
      WHERE garden_id = $1 AND plant_species_id = $2
      LIMIT 1
      `,
      [gardenId, scan.plant_species_id]
    );

    if (duplicate.rows.length > 0) {
      return fail("This plant is already in your garden.", 409);
    }

    const notes = typeof body.notes === "string" ? body.notes.trim() : null;
    const potType = typeof body.pot_type === "string" ? body.pot_type.trim() : null;
    const customName = typeof body.custom_name === "string" ? body.custom_name.trim() : null;

    const result = await pool.query(
      `
      INSERT INTO garden_plants (
        garden_id, user_id, plant_species_id,
        source_scan_id, custom_name, notes,
        pot_type, acquired_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE)
      RETURNING *
      `,
      [gardenId, user.id, scan.plant_species_id, scanId, customName, notes, potType]
    );

    return ok({ garden_plant: result.rows[0], garden_id: gardenId }, 201);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Failed to save plant to garden.",
      400
    );
  }
}