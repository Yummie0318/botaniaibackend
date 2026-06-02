import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = {
  params: Promise<{ plantId: string }>;
};

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { plantId } = await params;

    await pool.query(
      `
      DELETE FROM saved_plants
      WHERE user_id = $1 AND plant_species_id = $2
      `,
      [user.id, plantId]
    );

    return ok({ deleted: true });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to delete saved plant.", 400);
  }
}