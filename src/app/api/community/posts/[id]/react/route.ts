import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// POST /api/community/posts/:id/react
// Toggles a reaction — if already reacted with same type, removes it
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const body = await request.json();

    const reactionType = typeof body.reaction_type === "string" ? body.reaction_type.trim() : "like";
    const validTypes = ["like", "love", "helpful"];
    if (!validTypes.includes(reactionType)) return fail("Invalid reaction_type.", 400);

    // Check post exists
    const postCheck = await pool.query(
      `SELECT id FROM community_posts WHERE id = $1 AND status = 'published' LIMIT 1`,
      [id]
    );
    if (postCheck.rows.length === 0) return fail("Post not found.", 404);

    // Check if already reacted with this type
    const existing = await pool.query(
      `SELECT id FROM community_reactions WHERE user_id = $1 AND post_id = $2 AND reaction_type = $3 LIMIT 1`,
      [user.id, id, reactionType]
    );

    if (existing.rows.length > 0) {
      // Already reacted — toggle off (remove)
      await pool.query(
        `DELETE FROM community_reactions WHERE user_id = $1 AND post_id = $2 AND reaction_type = $3`,
        [user.id, id, reactionType]
      );
      return ok({ reacted: false, reaction_type: reactionType });
    } else {
      // Not reacted — add reaction
      await pool.query(
        `INSERT INTO community_reactions (user_id, post_id, reaction_type) VALUES ($1, $2, $3)`,
        [user.id, id, reactionType]
      );
      return ok({ reacted: true, reaction_type: reactionType });
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to react to post.", 400);
  }
}