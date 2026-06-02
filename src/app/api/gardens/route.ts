import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

// GET /api/gardens — list all gardens for the user
export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);

    const result = await pool.query(
      `
      SELECT
        g.*,
        COUNT(gp.id)::int AS plant_count
      FROM gardens g
      LEFT JOIN garden_plants gp ON gp.garden_id = g.id
      WHERE g.user_id = $1
      GROUP BY g.id
      ORDER BY g.created_at DESC
      `,
      [user.id]
    );

    return ok({ gardens: result.rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch gardens.", 400);
  }
}

// POST /api/gardens — create a new garden
export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const body = await request.json();

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return fail("Garden name is required.", 400);

    const description = typeof body.description === "string" ? body.description.trim() : null;
    const locationName = typeof body.location_name === "string" ? body.location_name.trim() : null;
    const isIndoor = body.is_indoor === true;

    const result = await pool.query(
      `
      INSERT INTO gardens (user_id, name, description, location_name, is_indoor)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [user.id, name, description, locationName, isIndoor]
    );

    return ok({ garden: result.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to create garden.", 400);
  }
}