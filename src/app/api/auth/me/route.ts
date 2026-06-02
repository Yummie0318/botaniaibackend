import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

export async function GET(request: NextRequest) {
  try {
    const authUser = await requireAuth(request);

    const result = await pool.query(
      `
      SELECT id, full_name, email, username, avatar_url, role, status, created_at
      FROM app_users
      WHERE id = $1
      LIMIT 1
      `,
      [authUser.id]
    );

    return ok({ user: result.rows[0] });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Unauthorized", 401);
  }
}