import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// POST /api/users/:id/follow — follow a user
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: targetId } = await params;

    if (user.id === targetId) {
      return fail("You cannot follow yourself.", 400);
    }

    // Check target user exists
    const targetCheck = await pool.query(
      `SELECT id FROM app_users WHERE id = $1 AND status = 'active' LIMIT 1`,
      [targetId]
    );
    if (targetCheck.rows.length === 0) return fail("User not found.", 404);

    // Insert follow — ignore if already following
    await pool.query(
      `
      INSERT INTO user_follows (follower_id, following_id)
      VALUES ($1, $2)
      ON CONFLICT (follower_id, following_id) DO NOTHING
      `,
      [user.id, targetId]
    );

    // Get updated counts
    const counts = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM user_follows WHERE following_id = $1) AS follower_count,
        (SELECT COUNT(*) FROM user_follows WHERE follower_id = $1)  AS following_count
      `,
      [targetId]
    );

    return ok({
      following: true,
      follower_count: Number(counts.rows[0].follower_count),
      following_count: Number(counts.rows[0].following_count),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to follow user.", 400);
  }
}

// DELETE /api/users/:id/follow — unfollow a user
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: targetId } = await params;

    await pool.query(
      `DELETE FROM user_follows WHERE follower_id = $1 AND following_id = $2`,
      [user.id, targetId]
    );

    const counts = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM user_follows WHERE following_id = $1) AS follower_count,
        (SELECT COUNT(*) FROM user_follows WHERE follower_id = $1)  AS following_count
      `,
      [targetId]
    );

    return ok({
      following: false,
      follower_count: Number(counts.rows[0].follower_count),
      following_count: Number(counts.rows[0].following_count),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to unfollow user.", 400);
  }
}