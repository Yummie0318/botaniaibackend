import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// GET /api/gardens/:id — get one garden with its plants
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    const gardenResult = await pool.query(
      `SELECT * FROM gardens WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [id, user.id]
    );

    if (gardenResult.rows.length === 0) return fail("Garden not found.", 404);

    const plantsResult = await pool.query(
      `
      SELECT
        gp.*,
        ps.scientific_name,
        ps.common_name,
        ps.category,
        ps.description_short,
        ma.public_url AS image_url
      FROM garden_plants gp
      LEFT JOIN plant_species ps ON ps.id = gp.plant_species_id
      LEFT JOIN scan_images si ON si.scan_id = gp.source_scan_id
        AND si.sort_order = (
          SELECT MIN(sort_order) FROM scan_images WHERE scan_id = gp.source_scan_id
        )
      LEFT JOIN media_assets ma ON ma.id = si.media_asset_id
      WHERE gp.garden_id = $1
      ORDER BY gp.created_at DESC
      `,
      [id]
    );

    return ok({ garden: gardenResult.rows[0], plants: plantsResult.rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch garden.", 400);
  }
}

// PATCH /api/gardens/:id — update garden name/description
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const body = await request.json();

    const existing = await pool.query(
      `SELECT id FROM gardens WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [id, user.id]
    );
    if (existing.rows.length === 0) return fail("Garden not found.", 404);

    const name = typeof body.name === "string" ? body.name.trim() : null;
    const description = typeof body.description === "string" ? body.description.trim() : null;
    const locationName = typeof body.location_name === "string" ? body.location_name.trim() : null;
    const isIndoor = typeof body.is_indoor === "boolean" ? body.is_indoor : null;

    const result = await pool.query(
      `
      UPDATE gardens SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        location_name = COALESCE($3, location_name),
        is_indoor = COALESCE($4, is_indoor),
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
      `,
      [name, description, locationName, isIndoor, id]
    );

    return ok({ garden: result.rows[0] });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to update garden.", 400);
  }
}

// DELETE /api/gardens/:id — delete a garden
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    const existing = await pool.query(
      `SELECT id FROM gardens WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [id, user.id]
    );
    if (existing.rows.length === 0) return fail("Garden not found.", 404);

    await pool.query(`DELETE FROM gardens WHERE id = $1`, [id]);

    return ok({ deleted: true });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to delete garden.", 400);
  }
}