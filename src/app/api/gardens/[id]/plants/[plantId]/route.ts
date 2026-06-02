import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string; plantId: string }> };


// GET /api/gardens/:id/plants/:plantId — get single plant detail
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: gardenId, plantId } = await params;

    const result = await pool.query(
      `
      SELECT
        gp.*,
        ps.scientific_name,
        ps.common_name,
        ps.family_name,
        ps.genus_name,
        ps.category,
        ps.description_short,
        ps.edible_status,
        ps.medicinal_status,
        ps.toxicity_status,
        ma.public_url AS image_url
      FROM garden_plants gp
      LEFT JOIN plant_species ps ON ps.id = gp.plant_species_id
      LEFT JOIN scan_images si ON si.scan_id = gp.source_scan_id
        AND si.sort_order = (
          SELECT MIN(sort_order) FROM scan_images WHERE scan_id = gp.source_scan_id
        )
      LEFT JOIN media_assets ma ON ma.id = si.media_asset_id
      WHERE gp.id = $1
        AND gp.garden_id = $2
        AND gp.user_id = $3
      LIMIT 1
      `,
      [plantId, gardenId, user.id]
    );

    if (result.rows.length === 0) return fail("Plant not found.", 404);

    return ok({ garden_plant: result.rows[0] });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch plant.", 400);
  }
}

// DELETE /api/gardens/:id/plants/:plantId — remove a plant from a garden
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: gardenId, plantId } = await params;

    const existing = await pool.query(
      `SELECT id FROM garden_plants WHERE id = $1 AND garden_id = $2 AND user_id = $3 LIMIT 1`,
      [plantId, gardenId, user.id]
    );
    if (existing.rows.length === 0) return fail("Plant not found.", 404);

    await pool.query(`DELETE FROM garden_plants WHERE id = $1`, [plantId]);

    return ok({ deleted: true });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to remove plant.", 400);
  }
}

// PATCH /api/gardens/:id/plants/:plantId — update notes, health, pot type
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: gardenId, plantId } = await params;
    const body = await request.json();

    const existing = await pool.query(
      `SELECT id FROM garden_plants WHERE id = $1 AND garden_id = $2 AND user_id = $3 LIMIT 1`,
      [plantId, gardenId, user.id]
    );
    if (existing.rows.length === 0) return fail("Plant not found.", 404);

    const customName = typeof body.custom_name === "string" ? body.custom_name.trim() : null;
    const notes = typeof body.notes === "string" ? body.notes.trim() : null;
    const potType = typeof body.pot_type === "string" ? body.pot_type.trim() : null;
    const currentHealth = typeof body.current_health === "string" ? body.current_health : null;

    const validHealth = ["healthy", "warning", "sick", "recovering", "dead", "unknown"];
    if (currentHealth && !validHealth.includes(currentHealth)) {
      return fail("Invalid health status.", 400);
    }

    const result = await pool.query(
      `
      UPDATE garden_plants SET
        custom_name = COALESCE($1, custom_name),
        notes = COALESCE($2, notes),
        pot_type = COALESCE($3, pot_type),
        current_health = COALESCE($4, current_health),
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
      `,
      [customName, notes, potType, currentHealth, plantId]
    );

    return ok({ garden_plant: result.rows[0] });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to update plant.", 400);
  }
}