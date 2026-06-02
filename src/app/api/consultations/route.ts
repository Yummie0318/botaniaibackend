import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

// ── GET /api/consultations ────────────────────────────────────────────────────
// Returns the logged-in user's consultations (inbox).
// Experts also see consultations assigned to them or open ones they can claim.

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const { searchParams } = new URL(request.url);

    const limit  = Math.min(Number(searchParams.get("limit")  || 20), 100);
    const offset = Math.max(Number(searchParams.get("offset") || 0),  0);
    const status = searchParams.get("status") || null; // filter by status

    // Check if the requester is a verified expert
    const expertCheck = await pool.query(
      `SELECT id FROM expert_profiles WHERE user_id = $1 AND is_verified = TRUE`,
      [user.id]
    );
    const expertProfile = expertCheck.rows[0] || null;

    let rows;

    if (expertProfile) {
      // Experts see: their assigned consultations + all open ones they can claim
      const result = await pool.query(
        `
        SELECT
          c.id,
          c.title,
          c.body,
          c.status,
          c.is_urgent,
          c.is_public,
          c.created_at,
          c.answered_at,
          c.assigned_expert_id,
          -- User who asked
          au.id            AS user_id,
          au.full_name     AS user_name,
          au.username      AS user_username,
          -- Linked scan info
          c.scan_id,
          si.predicted_common_name AS scan_plant_name,
          ma.public_url            AS scan_image_url,
          -- Linked diagnosis info
          c.diagnosis_id,
          sd.diagnosis_name,
          sd.diagnosis_type,
          -- Reply count
          (
            SELECT COUNT(*) FROM consultation_replies r
            WHERE r.consultation_id = c.id AND r.is_deleted = FALSE
          ) AS reply_count
        FROM consultations c
        JOIN app_users au ON au.id = c.user_id
        LEFT JOIN scans s ON s.id = c.scan_id
        LEFT JOIN scan_identifications si ON si.scan_id = s.id AND si.is_primary = TRUE
        LEFT JOIN scan_images simg
          ON simg.scan_id = s.id
          AND simg.sort_order = (SELECT MIN(sort_order) FROM scan_images WHERE scan_id = s.id)
        LEFT JOIN media_assets ma ON ma.id = simg.media_asset_id
        LEFT JOIN scan_diagnoses sd ON sd.id = c.diagnosis_id
        WHERE
          (c.assigned_expert_id = $1 OR c.status = 'open')
          AND ($3::text IS NULL OR c.status = $3::text)
        ORDER BY c.is_urgent DESC, c.created_at DESC
        LIMIT $4 OFFSET $5
        `,
        [expertProfile.id, user.id, status, limit, offset]
      );
      rows = result.rows;
    } else {
      // Regular users see only their own consultations
      const result = await pool.query(
        `
        SELECT
          c.id,
          c.title,
          c.body,
          c.status,
          c.is_urgent,
          c.is_public,
          c.created_at,
          c.answered_at,
          c.assigned_expert_id,
          -- Assigned expert info
          ep.title         AS expert_title,
          au_e.full_name   AS expert_name,
          au_e.username    AS expert_username,
          -- Linked scan info
          c.scan_id,
          si.predicted_common_name AS scan_plant_name,
          ma.public_url            AS scan_image_url,
          -- Linked diagnosis
          c.diagnosis_id,
          sd.diagnosis_name,
          sd.diagnosis_type,
          -- Reply count
          (
            SELECT COUNT(*) FROM consultation_replies r
            WHERE r.consultation_id = c.id AND r.is_deleted = FALSE
          ) AS reply_count
        FROM consultations c
        LEFT JOIN expert_profiles ep ON ep.id = c.assigned_expert_id
        LEFT JOIN app_users au_e ON au_e.id = ep.user_id
        LEFT JOIN scans s ON s.id = c.scan_id
        LEFT JOIN scan_identifications si ON si.scan_id = s.id AND si.is_primary = TRUE
        LEFT JOIN scan_images simg
          ON simg.scan_id = s.id
          AND simg.sort_order = (SELECT MIN(sort_order) FROM scan_images WHERE scan_id = s.id)
        LEFT JOIN media_assets ma ON ma.id = simg.media_asset_id
        LEFT JOIN scan_diagnoses sd ON sd.id = c.diagnosis_id
        WHERE
          c.user_id = $1
          AND ($2::text IS NULL OR c.status = $2::text)
        ORDER BY c.created_at DESC
        LIMIT $3 OFFSET $4
        `,
        [user.id, status, limit, offset]
      );
      rows = result.rows;
    }

    return ok({
      consultations: rows,
      is_expert: !!expertProfile,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch consultations.", 400);
  }
}

// ── POST /api/consultations ───────────────────────────────────────────────────
// Create a new consultation. Scan + diagnosis are optional but encouraged.

export async function POST(request: NextRequest) {
  try {
    const user = await requireAuth(request);
    const body = await request.json();

    const {
      title,
      body: questionBody,
      scan_id         = null,
      diagnosis_id    = null,
      garden_plant_id = null,
      image_asset_ids = [],
      is_urgent       = false,
    } = body;

    if (!title?.trim())        return fail("title is required.", 400);
    if (!questionBody?.trim()) return fail("body is required.", 400);

    // If a diagnosis is linked, inherit its urgency flag automatically
    let urgent = is_urgent;
    if (diagnosis_id && !urgent) {
      const diagResult = await pool.query(
        `SELECT structured_result->>'is_urgent' AS is_urgent FROM scan_diagnoses WHERE id = $1`,
        [diagnosis_id]
      );
      if (diagResult.rows[0]?.is_urgent === "true") urgent = true;
    }

    const result = await pool.query(
      `
      INSERT INTO consultations (
        user_id, scan_id, diagnosis_id, garden_plant_id,
        title, body, image_asset_ids, is_urgent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        user.id,
        scan_id,
        diagnosis_id,
        garden_plant_id,
        title.trim(),
        questionBody.trim(),
        image_asset_ids,
        urgent,
      ]
    );

    return ok({ consultation: result.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to create consultation.", 400);
  }
}