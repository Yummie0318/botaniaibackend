import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

// ── GET /api/experts ──────────────────────────────────────────────────────────
// Returns all verified experts. Used on the "Pick an Expert" screen.

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
    const { searchParams } = new URL(request.url);

    const specialization = searchParams.get("specialization") || null;

    const result = await pool.query(
      `
      SELECT
        ep.id,
        ep.title,
        ep.bio,
        ep.specializations,
        ep.years_experience,
        ep.location,
        ep.total_replies,
        ep.avg_response_hrs,
        ep.verified_at,
        au.id          AS user_id,
        au.full_name   AS name,
        au.username,
        ma.public_url  AS avatar_url
      FROM expert_profiles ep
      JOIN app_users au ON au.id = ep.user_id
      LEFT JOIN media_assets ma ON ma.id = au.avatar_asset_id
      WHERE
        ep.is_verified = TRUE
        AND (
          $1::text IS NULL
          OR $1::text = ANY(ep.specializations)
        )
      ORDER BY ep.total_replies DESC, ep.verified_at ASC
      `,
      [specialization]
    );

    return ok({ experts: result.rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch experts.", 400);
  }
}