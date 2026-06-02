import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// Calculate the next due date based on frequency
function calcNextDueAt(current: Date, frequencyType: string, intervalValue: number | null): Date {
  const next = new Date(current);

  switch (frequencyType) {
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      break;
    case "custom":
      next.setDate(next.getDate() + (intervalValue ?? 1));
      break;
    case "once":
    default:
      // One-time reminders don't recur — deactivate instead
      break;
  }

  return next;
}

// POST /api/reminders/:id/complete
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    // Verify reminder belongs to user
    const reminderResult = await pool.query(
      `
      SELECT cr.* FROM care_reminders cr
      JOIN garden_plants gp ON gp.id = cr.garden_plant_id
      WHERE cr.id = $1 AND gp.user_id = $2
      LIMIT 1
      `,
      [id, user.id]
    );

    if (reminderResult.rows.length === 0) return fail("Reminder not found.", 404);

    const reminder = reminderResult.rows[0];
    const now = new Date();

    // Optional notes from the request body
    const notes = typeof body.notes === "string" ? body.notes.trim() : null;
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};

    // Map reminder_type → garden_events event_type
    // (reminder types are a subset of event types, so direct mapping works)
    const eventType = reminder.reminder_type as string;
    const validEventTypes = ["watering", "fertilizing", "pruning", "repotting", "custom"];

    // "custom" reminder_type logs as a "note" event if not in the valid list
    const resolvedEventType = validEventTypes.includes(eventType) ? eventType : "note";

    // 1. Log a garden_event
    const eventResult = await pool.query(
      `
      INSERT INTO garden_events (garden_plant_id, event_type, event_date, notes, metadata)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [reminder.garden_plant_id, resolvedEventType, now, notes, JSON.stringify(metadata)]
    );

    // 2. Update the reminder
    let updatedReminder;

    if (reminder.frequency_type === "once") {
      // One-time reminder: mark inactive
      const updated = await pool.query(
        `
        UPDATE care_reminders SET
          last_completed_at = $1,
          is_active         = false,
          updated_at        = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [now, id]
      );
      updatedReminder = updated.rows[0];
    } else {
      // Recurring: advance next_due_at from current next_due_at (not now, to avoid drift)
      const baseDate = new Date(reminder.next_due_at);
      const nextDueAt = calcNextDueAt(baseDate, reminder.frequency_type, reminder.interval_value);

      const updated = await pool.query(
        `
        UPDATE care_reminders SET
          last_completed_at = $1,
          next_due_at       = $2,
          updated_at        = NOW()
        WHERE id = $3
        RETURNING *
        `,
        [now, nextDueAt, id]
      );
      updatedReminder = updated.rows[0];
    }

    return ok({
      reminder: updatedReminder,
      event: eventResult.rows[0],
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to complete reminder.", 400);
  }
}