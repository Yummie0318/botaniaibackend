import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get("q") || "").trim();
    const limit = Math.min(Number(searchParams.get("limit") || 20), 50);

    if (!q) {
      return ok({ plants: [] });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        common_name,
        scientific_name,
        local_name,
        category,
        edible_status,
        medicinal_status,
        toxicity_status,
        description_short
      FROM plant_species
      WHERE deleted_at IS NULL
        AND (
          common_name ILIKE $1
          OR scientific_name ILIKE $1
          OR local_name ILIKE $1
          OR search_text ILIKE $1
        )
      ORDER BY common_name ASC
      LIMIT $2
      `,
      [`%${q}%`, limit]
    );

    return ok({ plants: result.rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Plant search failed.", 400);
  }
}