import { pool } from "@/lib/db";

// ── Thresholds for auto-granting Community Expert status ─────────────────────
const THRESHOLDS = {
  total_scans:      50,
  unique_species:   20,
  disease_scans:    5,
  account_age_days: 30,
};

/**
 * Checks if a user qualifies for Community Expert status.
 * If they do and don't already have an expert_profile, one is created automatically.
 *
 * Call this at the END of both:
 *   - POST /api/scans/[id]/identify
 *   - POST /api/scans/[id]/diagnose
 *
 * Fire-and-forget — errors are caught and logged, never surfaced to the user.
 */
export async function checkAndGrantExpertStatus(userId: string): Promise<void> {
  try {
    // Already has a profile (any tier) → skip
    const existing = await pool.query(
      `SELECT id FROM expert_profiles WHERE user_id = $1`,
      [userId]
    );
    if (existing.rows.length > 0) return;

    // Pull scan stats
    const statsResult = await pool.query(
      `
      SELECT
        COUNT(*)                                         AS total_scans,
        COUNT(DISTINCT si.plant_species_id)              AS unique_species,
        COUNT(*) FILTER (WHERE s.scan_type = 'disease') AS disease_scans,
        MIN(s.created_at)                                AS first_scan_at
      FROM scans s
      LEFT JOIN scan_identifications si
        ON si.scan_id = s.id AND si.is_primary = TRUE
      WHERE s.user_id = $1
        AND s.status  = 'completed'
      `,
      [userId]
    );

    const row = statsResult.rows[0];
    if (!row || !row.first_scan_at) return;

    const totalScans     = Number(row.total_scans    || 0);
    const uniqueSpecies  = Number(row.unique_species || 0);
    const diseaseScans   = Number(row.disease_scans  || 0);
    const accountAgeDays =
      (Date.now() - new Date(row.first_scan_at).getTime()) / 86_400_000;

    const qualifies =
      totalScans    >= THRESHOLDS.total_scans      &&
      uniqueSpecies >= THRESHOLDS.unique_species   &&
      diseaseScans  >= THRESHOLDS.disease_scans    &&
      accountAgeDays >= THRESHOLDS.account_age_days;

    if (!qualifies) return;

    await pool.query(
      `
      INSERT INTO expert_profiles (user_id, title, tier, is_verified, verified_at)
      VALUES ($1, 'Community Expert', 'community', TRUE, NOW())
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId]
    );

    console.log(`[expertEligibility] Granted Community Expert to user ${userId}`);
  } catch (error) {
    console.error("[expertEligibility] Error checking expert status:", error);
  }
}

/**
 * Promotes a Community Expert to Senior when total_replies hits 100.
 * Call after incrementing total_replies in the consultation reply handler.
 */
export async function checkAndPromoteToSenior(expertProfileId: string): Promise<void> {
  try {
    await pool.query(
      `
      UPDATE expert_profiles
      SET tier = 'senior'
      WHERE id          = $1
        AND tier        = 'community'
        AND total_replies >= 100
      `,
      [expertProfileId]
    );
  } catch (error) {
    console.error("[expertEligibility] Error promoting to senior:", error);
  }
}