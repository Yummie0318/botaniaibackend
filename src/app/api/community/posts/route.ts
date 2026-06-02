import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

// GET /api/community/posts — paginated feed
export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 50);
    const offset = parseInt(searchParams.get("offset") ?? "0", 10);

    const result = await pool.query(
      `
      SELECT
        cp.id,
        cp.title,
        cp.body,
        cp.visibility,
        cp.created_at,
        -- Author
        u.id           AS author_id,
        u.full_name    AS author_name,
        u.username     AS author_username,
        u.avatar_url   AS author_avatar,
        -- Plant species (optional)
        ps.id          AS species_id,
        ps.common_name AS species_common_name,
        ps.scientific_name AS species_scientific_name,
        -- Image (optional)
        ma.public_url  AS image_url,
        -- Counts
        COUNT(DISTINCT cc.id)                                        AS comment_count,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.reaction_type = 'like')    AS like_count,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.reaction_type = 'love')    AS love_count,
        COUNT(DISTINCT cr.id) FILTER (WHERE cr.reaction_type = 'helpful') AS helpful_count,
        -- Did current user react?
        MAX(CASE WHEN cr_me.reaction_type = 'like'    THEN 1 ELSE 0 END) AS user_liked,
        MAX(CASE WHEN cr_me.reaction_type = 'love'    THEN 1 ELSE 0 END) AS user_loved,
        MAX(CASE WHEN cr_me.reaction_type = 'helpful' THEN 1 ELSE 0 END) AS user_helped
      FROM community_posts cp
      JOIN app_users u ON u.id = cp.user_id
      LEFT JOIN plant_species ps ON ps.id = cp.plant_species_id
      LEFT JOIN media_assets ma ON ma.id = cp.image_asset_id
      LEFT JOIN community_comments cc ON cc.post_id = cp.id AND cc.status = 'published'
      LEFT JOIN community_reactions cr ON cr.post_id = cp.id
      LEFT JOIN community_reactions cr_me ON cr_me.post_id = cp.id AND cr_me.user_id = $1
      WHERE cp.status = 'published'
        AND cp.visibility = 'public'
      GROUP BY cp.id, u.id, ps.id, ma.public_url
      ORDER BY cp.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [user.id, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM community_posts WHERE status = 'published' AND visibility = 'public'`
    );

    return ok({
      posts: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
      limit,
      offset,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch posts.", 400);
  }
}

// POST /api/community/posts — create a post
export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const body = await request.json();

    const title = typeof body.title === "string" ? body.title.trim() : null;
    const postBody = typeof body.body === "string" ? body.body.trim() : "";
    const visibility = typeof body.visibility === "string" ? body.visibility.trim() : "public";
    const plantSpeciesId = typeof body.plant_species_id === "string" ? body.plant_species_id : null;
    const scanId = typeof body.scan_id === "string" ? body.scan_id : null;
    const imageAssetId = typeof body.image_asset_id === "string" ? body.image_asset_id : null;

    if (!postBody) return fail("Post body is required.", 400);

    const validVisibility = ["public", "followers", "private"];
    if (!validVisibility.includes(visibility)) return fail("Invalid visibility.", 400);

    let resolvedImageAssetId = imageAssetId;
    if (!resolvedImageAssetId && scanId) {
      // Try scan_images first (multi-image scans)
      const scanImageResult = await pool.query(
        `
        SELECT ma.id
        FROM scan_images si
        JOIN media_assets ma ON ma.id = si.media_asset_id
        WHERE si.scan_id = $1
        ORDER BY si.sort_order ASC
        LIMIT 1
        `,
        [scanId]
      );

      if (scanImageResult.rows.length > 0) {
        resolvedImageAssetId = scanImageResult.rows[0].id;
      } else {
        // Fall back to the scan's primary image_asset_id
        const scanResult = await pool.query(
          `SELECT image_asset_id FROM scans WHERE id = $1 LIMIT 1`,
          [scanId]
        );
        if (scanResult.rows.length > 0) {
          resolvedImageAssetId = scanResult.rows[0].image_asset_id;
        }
      }

      // Also try to get plant_species_id from the scan if not provided
      if (!plantSpeciesId) {
        const identResult = await pool.query(
          `
          SELECT plant_species_id
          FROM scan_identifications
          WHERE scan_id = $1 AND is_primary = TRUE
          LIMIT 1
          `,
          [scanId]
        );
        if (identResult.rows.length > 0 && identResult.rows[0].plant_species_id) {
          // Use it below
          Object.assign(body, { _resolved_species_id: identResult.rows[0].plant_species_id });
        }
      }
    }

    const resolvedPlantSpeciesId = plantSpeciesId || body._resolved_species_id || null;

    const result = await pool.query(
      `
      INSERT INTO community_posts
        (user_id, title, body, visibility, plant_species_id, scan_id, image_asset_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [user.id, title, postBody, visibility, resolvedPlantSpeciesId, scanId, resolvedImageAssetId]
    );

    return ok({ post: result.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to create post.", 400);
  }
}