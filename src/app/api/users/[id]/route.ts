import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// GET /api/users/:id — get public user profile
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: targetId } = await params;

    // Get user profile
    const profileResult = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.username,
        u.avatar_url,
        u.country_code,
        u.created_at,
        -- Follow counts
        (SELECT COUNT(*) FROM user_follows WHERE following_id = u.id) AS follower_count,
        (SELECT COUNT(*) FROM user_follows WHERE follower_id  = u.id) AS following_count,
        -- Is current user following this user?
        EXISTS (
          SELECT 1 FROM user_follows
          WHERE follower_id = $2 AND following_id = u.id
        ) AS is_following,
        -- Post count
        (SELECT COUNT(*) FROM community_posts
         WHERE user_id = u.id AND status = 'published') AS post_count,
        -- Plant count
        (SELECT COUNT(*) FROM garden_plants WHERE user_id = u.id) AS plant_count,
        -- Scan count
        (SELECT COUNT(*) FROM scans
         WHERE user_id = u.id AND status = 'completed') AS scan_count
      FROM app_users u
      WHERE u.id = $1
        AND u.status = 'active'
        AND u.deleted_at IS NULL
      LIMIT 1
      `,
      [targetId, user.id]
    );

    if (profileResult.rows.length === 0) return fail("User not found.", 404);

    const profile = profileResult.rows[0];

    // Get user's public posts
    const postsResult = await pool.query(
      `
      SELECT
        cp.id,
        cp.title,
        cp.body,
        cp.created_at,
        ma.public_url AS image_url,
        ps.common_name AS species_common_name,
        COUNT(DISTINCT cc.id) AS comment_count,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.reaction_type = 'like') AS like_count
      FROM community_posts cp
      LEFT JOIN media_assets ma ON ma.id = cp.image_asset_id
      LEFT JOIN plant_species ps ON ps.id = cp.plant_species_id
      LEFT JOIN community_comments cc ON cc.post_id = cp.id
      LEFT JOIN community_reactions cr ON cr.post_id = cp.id
      WHERE cp.user_id = $1
        AND cp.status = 'published'
        AND cp.visibility = 'public'
      GROUP BY cp.id, ma.public_url, ps.common_name
      ORDER BY cp.created_at DESC
      LIMIT 20
      `,
      [targetId]
    );

// ✅ REPLACE WITH:
    // Get user's garden plants
    const plantsResult = await pool.query(
      `
      SELECT
        gp.id,
        gp.custom_name,
        gp.current_health,
        gp.acquired_at,
        gp.notes,
        ps.common_name,
        ps.scientific_name,
        ps.category,
        ma.public_url AS image_url
      FROM garden_plants gp
      LEFT JOIN plant_species ps ON ps.id = gp.plant_species_id
      LEFT JOIN scan_images si ON si.scan_id = gp.source_scan_id
        AND si.sort_order = (
          SELECT MIN(sort_order) FROM scan_images WHERE scan_id = gp.source_scan_id
        )
      LEFT JOIN media_assets ma ON ma.id = si.media_asset_id
      WHERE gp.user_id = $1
      ORDER BY gp.created_at DESC
      LIMIT 20
      `,
      [targetId]
    );

    return ok({
      profile: {
        ...profile,
        follower_count: Number(profile.follower_count),
        following_count: Number(profile.following_count),
        post_count: Number(profile.post_count),
        plant_count: Number(profile.plant_count),
        scan_count: Number(profile.scan_count),
        is_following: profile.is_following === true,
      },
      posts: postsResult.rows,
      plants: plantsResult.rows,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch profile.", 400);
  }
}