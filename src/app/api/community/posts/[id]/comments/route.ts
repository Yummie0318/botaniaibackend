import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// POST /api/community/posts/:id/comments — add a comment or reply
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: postId } = await params;
    const body = await request.json();

    const commentBody = typeof body.body === "string" ? body.body.trim() : "";
    const parentCommentId = typeof body.parent_comment_id === "string" ? body.parent_comment_id : null;

    if (!commentBody) return fail("Comment body is required.", 400);

    // Check post exists and is published
    const postCheck = await pool.query(
      `SELECT id FROM community_posts WHERE id = $1 AND status = 'published' LIMIT 1`,
      [postId]
    );
    if (postCheck.rows.length === 0) return fail("Post not found.", 404);

    // If replying, verify parent comment belongs to this post
    if (parentCommentId) {
      const parentCheck = await pool.query(
        `SELECT id FROM community_comments WHERE id = $1 AND post_id = $2 AND status = 'published' LIMIT 1`,
        [parentCommentId, postId]
      );
      if (parentCheck.rows.length === 0) return fail("Parent comment not found.", 404);
    }

    const result = await pool.query(
      `
      INSERT INTO community_comments (post_id, user_id, parent_comment_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [postId, user.id, parentCommentId, commentBody]
    );

    // Return comment with author info
    const commentWithAuthor = await pool.query(
      `
      SELECT
        cc.*,
        u.full_name  AS author_name,
        u.username   AS author_username,
        u.avatar_url AS author_avatar
      FROM community_comments cc
      JOIN app_users u ON u.id = cc.user_id
      WHERE cc.id = $1
      `,
      [result.rows[0].id]
    );

    return ok({ comment: commentWithAuthor.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to add comment.", 400);
  }
}