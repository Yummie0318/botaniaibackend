import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);

    const result = await pool.query(
      `
      SELECT
        sp.created_at AS saved_at,
        ps.id,
        ps.common_name,
        ps.scientific_name,
        ps.local_name,
        ps.category,
        ps.edible_status,
        ps.medicinal_status,
        ps.toxicity_status,
        ps.description_short
      FROM saved_plants sp
      JOIN plant_species ps ON ps.id = sp.plant_species_id
      WHERE sp.user_id = $1
      ORDER BY sp.created_at DESC
      `,
      [user.id]
    );

    return ok({ plants: result.rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch saved plants.", 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const body = await request.json();

    const { plant_species_id, source_scan_id = null, notes = null } = body;

    if (!plant_species_id) {
      return fail("plant_species_id is required.", 400);
    }

    const result = await pool.query(
      `
      INSERT INTO saved_plants (user_id, plant_species_id, source_scan_id, notes)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, plant_species_id)
      DO UPDATE SET
        notes = COALESCE(EXCLUDED.notes, saved_plants.notes)
      RETURNING *
      `,
      [user.id, plant_species_id, source_scan_id, notes]
    );

    return ok({ saved_plant: result.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to save plant.", 400);
  }
}