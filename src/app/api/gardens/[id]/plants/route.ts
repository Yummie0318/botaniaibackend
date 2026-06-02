import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// POST /api/gardens/:id/plants — add a plant to a garden
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: gardenId } = await params;
    const body = await request.json();

    // Verify garden belongs to user
    const gardenCheck = await pool.query(
      `SELECT id FROM gardens WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [gardenId, user.id]
    );
    if (gardenCheck.rows.length === 0) return fail("Garden not found.", 404);

    const plantSpeciesId = typeof body.plant_species_id === "string" ? body.plant_species_id : null;
    const sourceScanId = typeof body.source_scan_id === "string" ? body.source_scan_id : null;
    const customName = typeof body.custom_name === "string" ? body.custom_name.trim() : null;
    const notes = typeof body.notes === "string" ? body.notes.trim() : null;
    const potType = typeof body.pot_type === "string" ? body.pot_type.trim() : null;

    // Prevent duplicate — same species in same garden
    if (plantSpeciesId) {
      const duplicate = await pool.query(
        `SELECT id FROM garden_plants WHERE garden_id = $1 AND plant_species_id = $2 LIMIT 1`,
        [gardenId, plantSpeciesId]
      );
      if (duplicate.rows.length > 0) {
        return fail("This plant is already in your garden.", 409);
      }
    }

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
      [gardenId, user.id, plantSpeciesId, sourceScanId, customName, notes, potType]
    );

    return ok({ garden_plant: result.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to add plant.", 400);
  }
}