import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

// GET /api/reminders/upcoming
// Returns all active reminders for the user, sorted by next_due_at ascending.
// Optional query params:
//   ?days=7        — only reminders due within N days (default: all upcoming)
//   ?limit=50      — max results (default: 50)
export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);

    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get("days") ?? "0", 10);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200);

    const result = await pool.query(
      `
      SELECT
        cr.*,
        gp.custom_name                          AS plant_custom_name,
        COALESCE(ps.common_name, cr.title)      AS plant_common_name,
        ps.scientific_name                      AS plant_scientific_name,
        g.id                                    AS garden_id,
        g.name                                  AS garden_name,
        ma.public_url                           AS plant_image_url
      FROM care_reminders cr
      JOIN garden_plants gp ON gp.id = cr.garden_plant_id
      JOIN gardens g ON g.id = gp.garden_id
      LEFT JOIN plant_species ps ON ps.id = gp.plant_species_id
      LEFT JOIN scan_images si ON si.scan_id = gp.source_scan_id
        AND si.sort_order = (
          SELECT MIN(sort_order) FROM scan_images WHERE scan_id = gp.source_scan_id
        )
      LEFT JOIN media_assets ma ON ma.id = si.media_asset_id
      WHERE g.user_id = $1
        AND cr.is_active = true
        ${days > 0 ? `AND cr.next_due_at <= NOW() + ($3 || ' days')::interval` : ""}
      ORDER BY cr.next_due_at ASC
      LIMIT $2
      `,
      days > 0 ? [user.id, limit, days] : [user.id, limit]
    );

    // Group into overdue / today / upcoming for convenience
    const now = new Date();
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const overdue: typeof result.rows = [];
    const today: typeof result.rows = [];
    const upcoming: typeof result.rows = [];

    for (const row of result.rows) {
      const due = new Date(row.next_due_at);
      if (due < now) {
        overdue.push(row);
      } else if (due <= todayEnd) {
        today.push(row);
      } else {
        upcoming.push(row);
      }
    }

    return ok({
      overdue,
      today,
      upcoming,
      total: result.rows.length,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch upcoming reminders.", 400);
  }
}