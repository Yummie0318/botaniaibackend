import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// GET /api/users/:id/followers — list people following this user
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: targetId } = await params;

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.username,
        u.avatar_url,
        -- Is the current user following this person back?
        EXISTS (
          SELECT 1 FROM user_follows
          WHERE follower_id = $2 AND following_id = u.id
        ) AS is_following
      FROM user_follows uf
      JOIN app_users u ON u.id = uf.follower_id
      WHERE uf.following_id = $1
        AND u.status = 'active'
        AND u.deleted_at IS NULL
      ORDER BY uf.created_at DESC
      `,
      [targetId, user.id]
    );

    return ok({ followers: result.rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch followers.", 400);
  }
}