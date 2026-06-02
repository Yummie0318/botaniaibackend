import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";
import { checkAndPromoteToSenior } from "@/lib/expertEligibility";

type RouteContext = { params: Promise<{ id: string }> };

// ── GET /api/consultations/[id] ───────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    const result = await pool.query(
      `
      SELECT
        c.*,
        au.full_name       AS user_name,
        au.username        AS user_username,
        ep.title           AS expert_title,
        ep.bio             AS expert_bio,
        ep.specializations AS expert_specializations,
        ep.tier            AS expert_tier,
        au_e.full_name     AS expert_name,
        au_e.username      AS expert_username,
        s.status           AS scan_status,
        si.predicted_common_name     AS scan_plant_name,
        si.predicted_scientific_name AS scan_plant_scientific,
        si.confidence_score          AS scan_confidence,
        ma.public_url                AS scan_image_url,
        sd.diagnosis_name,
        sd.diagnosis_type,
        sd.confidence_score          AS diagnosis_confidence,
        sd.symptoms_detected,
        sd.treatment_summary,
        sd.prevention_summary,
        sd.structured_result         AS diagnosis_structured,
        gp.custom_name               AS garden_plant_nickname,
        ps.common_name               AS garden_plant_species
      FROM consultations c
      JOIN app_users au ON au.id = c.user_id
      LEFT JOIN expert_profiles ep ON ep.id = c.assigned_expert_id
      LEFT JOIN app_users au_e ON au_e.id = ep.user_id
      LEFT JOIN scans s ON s.id = c.scan_id
      LEFT JOIN scan_identifications si ON si.scan_id = s.id AND si.is_primary = TRUE
      LEFT JOIN scan_images simg
        ON simg.scan_id = s.id
        AND simg.sort_order = (SELECT MIN(sort_order) FROM scan_images WHERE scan_id = s.id)
      LEFT JOIN media_assets ma ON ma.id = simg.media_asset_id
      LEFT JOIN scan_diagnoses sd ON sd.id = c.diagnosis_id
      LEFT JOIN garden_plants gp ON gp.id = c.garden_plant_id
      LEFT JOIN plant_species ps ON ps.id = gp.plant_species_id
      WHERE c.id = $1
      `,
      [id]
    );

    if (!result.rows[0]) return fail("Consultation not found.", 404);
    const consultation = result.rows[0];

    const expertCheck = await pool.query(
      `SELECT id FROM expert_profiles WHERE user_id = $1 AND is_verified = TRUE`,
      [user.id]
    );
    const isExpert = expertCheck.rows.length > 0;
    const isOwner  = consultation.user_id === user.id;

    if (!isOwner && !isExpert) return fail("Access denied.", 403);

    const repliesResult = await pool.query(
      `
      SELECT
        r.id,
        r.body,
        r.author_role,
        r.image_asset_ids,
        r.created_at,
        au.id          AS author_id,
        au.full_name   AS author_name,
        au.username    AS author_username,
        ep.title       AS author_expert_title,
        ep.tier        AS author_expert_tier,
        ep.is_verified AS author_is_verified
      FROM consultation_replies r
      JOIN app_users au ON au.id = r.author_id
      LEFT JOIN expert_profiles ep ON ep.user_id = au.id
      WHERE r.consultation_id = $1 AND r.is_deleted = FALSE
      ORDER BY r.created_at ASC
      `,
      [id]
    );

    return ok({ consultation, replies: repliesResult.rows, is_expert: isExpert, is_owner: isOwner });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch consultation.", 400);
  }
}

// ── POST /api/consultations/[id] ─────────────────────────────────────────────

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const body = await request.json();
    const { action } = body;

    const cResult = await pool.query(`SELECT * FROM consultations WHERE id = $1`, [id]);
    if (!cResult.rows[0]) return fail("Consultation not found.", 404);
    const consultation = cResult.rows[0];

    const expertCheck = await pool.query(
      `SELECT id FROM expert_profiles WHERE user_id = $1 AND is_verified = TRUE`,
      [user.id]
    );
    const expertProfile = expertCheck.rows[0] || null;
    const isOwner = consultation.user_id === user.id;

    // ── reply ─────────────────────────────────────────────────────────────────
    if (action === "reply") {
      const { replyBody, image_asset_ids = [] } = body;
      if (!replyBody?.trim()) return fail("Reply body is required.", 400);
      if (!isOwner && !expertProfile) return fail("Access denied.", 403);
      if (consultation.status === "closed") return fail("Consultation is closed.", 400);

      const authorRole = expertProfile ? "expert" : "user";

      const reply = await pool.query(
        `
        INSERT INTO consultation_replies (consultation_id, author_id, body, image_asset_ids, author_role)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [id, user.id, replyBody.trim(), image_asset_ids, authorRole]
      );

      if (expertProfile && consultation.status !== "answered") {
        await pool.query(
          `
          UPDATE consultations
          SET status = 'answered', answered_at = NOW(),
              assigned_expert_id = COALESCE(assigned_expert_id, $2)
          WHERE id = $1
          `,
          [id, expertProfile.id]
        );

        await pool.query(
          `UPDATE expert_profiles SET total_replies = total_replies + 1 WHERE id = $1`,
          [expertProfile.id]
        );

        // Check if this expert qualifies for Senior promotion
        await checkAndPromoteToSenior(expertProfile.id);
      }

      return ok({ reply: reply.rows[0] }, 201);
    }

    // ── claim ─────────────────────────────────────────────────────────────────
    if (action === "claim") {
      if (!expertProfile) return fail("Only verified experts can claim consultations.", 403);
      if (consultation.status !== "open") return fail("Consultation is not open.", 400);
      if (consultation.assigned_expert_id) return fail("Already claimed.", 400);

      await pool.query(
        `UPDATE consultations SET status = 'assigned', assigned_expert_id = $2 WHERE id = $1`,
        [id, expertProfile.id]
      );

      return ok({ message: "Consultation claimed." });
    }

    // ── close ─────────────────────────────────────────────────────────────────
    if (action === "close") {
      if (!isOwner) return fail("Only the consultation owner can close it.", 403);
      if (consultation.status === "closed") return fail("Already closed.", 400);

      await pool.query(
        `UPDATE consultations SET status = 'closed', closed_at = NOW() WHERE id = $1`,
        [id]
      );

      return ok({ message: "Consultation closed." });
    }

    return fail(`Unknown action: ${action}`, 400);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to process consultation.", 400);
  }
}