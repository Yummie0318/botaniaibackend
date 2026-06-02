import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// DELETE /api/community/comments/:id — delete own comment
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    const existing = await pool.query(
      `SELECT id FROM community_comments WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [id, user.id]
    );
    if (existing.rows.length === 0) return fail("Comment not found.", 404);

    // Soft delete
    await pool.query(
      `UPDATE community_comments SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    return ok({ deleted: true });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to delete comment.", 400);
  }
}