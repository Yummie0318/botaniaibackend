import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// POST /api/community/comments/:id/react
// Toggles a reaction on a comment — only 'like' supported for comments
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    const reactionType = typeof body.reaction_type === "string" ? body.reaction_type.trim() : "like";
    const validTypes = ["like", "love", "helpful"];
    if (!validTypes.includes(reactionType)) return fail("Invalid reaction_type.", 400);

    // Check comment exists
    const commentCheck = await pool.query(
      `SELECT id FROM community_comments WHERE id = $1 AND status = 'published' LIMIT 1`,
      [id]
    );
    if (commentCheck.rows.length === 0) return fail("Comment not found.", 404);

    // Toggle
    const existing = await pool.query(
      `SELECT id FROM community_reactions WHERE user_id = $1 AND comment_id = $2 AND reaction_type = $3 LIMIT 1`,
      [user.id, id, reactionType]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `DELETE FROM community_reactions WHERE user_id = $1 AND comment_id = $2 AND reaction_type = $3`,
        [user.id, id, reactionType]
      );
      return ok({ reacted: false, reaction_type: reactionType });
    } else {
      await pool.query(
        `INSERT INTO community_reactions (user_id, comment_id, reaction_type) VALUES ($1, $2, $3)`,
        [user.id, id, reactionType]
      );
      return ok({ reacted: true, reaction_type: reactionType });
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to react to comment.", 400);
  }
}