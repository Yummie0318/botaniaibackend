import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// GET /api/community/posts/:id — single post with comments
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    // Post with counts and user reaction
    const postResult = await pool.query(
      `
      SELECT
        cp.id,
        cp.title,
        cp.body,
        cp.visibility,
        cp.status,
        cp.created_at,
        cp.updated_at,
        u.id           AS author_id,
        u.full_name    AS author_name,
        u.username     AS author_username,
        u.avatar_url   AS author_avatar,
        ps.id          AS species_id,
        ps.common_name AS species_common_name,
        ps.scientific_name AS species_scientific_name,
        ma.public_url  AS image_url,
        COUNT(DISTINCT cc.id)                                             AS comment_count,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.reaction_type = 'like')    AS like_count,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.reaction_type = 'love')    AS love_count,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.reaction_type = 'helpful') AS helpful_count,
        MAX(CASE WHEN cr_me.reaction_type = 'like'    THEN 1 ELSE 0 END)  AS user_liked,
        MAX(CASE WHEN cr_me.reaction_type = 'love'    THEN 1 ELSE 0 END)  AS user_loved,
        MAX(CASE WHEN cr_me.reaction_type = 'helpful' THEN 1 ELSE 0 END)  AS user_helped
      FROM community_posts cp
      JOIN app_users u ON u.id = cp.user_id
      LEFT JOIN plant_species ps ON ps.id = cp.plant_species_id
      LEFT JOIN media_assets ma ON ma.id = cp.image_asset_id
      LEFT JOIN community_comments cc ON cc.post_id = cp.id AND cc.status = 'published'
      LEFT JOIN community_reactions cr ON cr.post_id = cp.id
      LEFT JOIN community_reactions cr_me ON cr_me.post_id = cp.id AND cr_me.user_id = $2
      WHERE cp.id = $1 AND cp.status = 'published'
      GROUP BY cp.id, u.id, ps.id, ma.public_url
      LIMIT 1
      `,
      [id, user.id]
    );

    if (postResult.rows.length === 0) return fail("Post not found.", 404);

    // Comments (top-level only, replies nested below)
    const commentsResult = await pool.query(
      `
      SELECT
        cc.id,
        cc.post_id,
        cc.parent_comment_id,
        cc.body,
        cc.created_at,
        u.id         AS author_id,
        u.full_name  AS author_name,
        u.username   AS author_username,
        u.avatar_url AS author_avatar,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.reaction_type = 'like') AS like_count,
        MAX(CASE WHEN cr_me.reaction_type = 'like' THEN 1 ELSE 0 END)  AS user_liked
      FROM community_comments cc
      JOIN app_users u ON u.id = cc.user_id
      LEFT JOIN community_reactions cr ON cr.comment_id = cc.id
      LEFT JOIN community_reactions cr_me ON cr_me.comment_id = cc.id AND cr_me.user_id = $2
      WHERE cc.post_id = $1 AND cc.status = 'published'
      GROUP BY cc.id, u.id
      ORDER BY cc.created_at ASC
      `,
      [id, user.id]
    );

    // Nest replies under their parent
    const allComments = commentsResult.rows;
    const topLevel = allComments.filter((c) => !c.parent_comment_id);
    const replies = allComments.filter((c) => c.parent_comment_id);

    const comments = topLevel.map((c) => ({
      ...c,
      replies: replies.filter((r) => r.parent_comment_id === c.id),
    }));

    return ok({ post: postResult.rows[0], comments });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch post.", 400);
  }
}

// DELETE /api/community/posts/:id — delete own post
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    const existing = await pool.query(
      `SELECT id FROM community_posts WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [id, user.id]
    );
    if (existing.rows.length === 0) return fail("Post not found.", 404);

    // Soft delete — set status to deleted
    await pool.query(
      `UPDATE community_posts SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    return ok({ deleted: true });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to delete post.", 400);
  }
}