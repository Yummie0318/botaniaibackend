import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string }> };

// Helper — verify reminder belongs to user
async function getOwnedReminder(reminderId: string, userId: string) {
  const result = await pool.query(
    `
    SELECT cr.* FROM care_reminders cr
    JOIN garden_plants gp ON gp.id = cr.garden_plant_id
    WHERE cr.id = $1 AND gp.user_id = $2
    LIMIT 1
    `,
    [reminderId, userId]
  );
  return result.rows[0] ?? null;
}

// GET /api/reminders/:id
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    const reminder = await getOwnedReminder(id, user.id);
    if (!reminder) return fail("Reminder not found.", 404);

    return ok({ reminder });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch reminder.", 400);
  }
}

// PATCH /api/reminders/:id
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;
    const body = await request.json();

    const reminder = await getOwnedReminder(id, user.id);
    if (!reminder) return fail("Reminder not found.", 404);

    const validReminderTypes = ["watering", "fertilizing", "pruning", "repotting", "custom"];
    const validFrequencyTypes = ["once", "daily", "weekly", "monthly", "custom"];

    const reminderType = typeof body.reminder_type === "string" ? body.reminder_type.trim() : null;
    const title = typeof body.title === "string" ? body.title.trim() : null;
    const description = typeof body.description === "string" ? body.description.trim() : null;
    const frequencyType = typeof body.frequency_type === "string" ? body.frequency_type.trim() : null;
    const intervalValue = typeof body.interval_value === "number" ? body.interval_value : null;
    const nextDueAt = typeof body.next_due_at === "string" ? body.next_due_at : null;
    const isActive = typeof body.is_active === "boolean" ? body.is_active : null;

    if (reminderType && !validReminderTypes.includes(reminderType)) return fail("Invalid reminder_type.", 400);
    if (frequencyType && !validFrequencyTypes.includes(frequencyType)) return fail("Invalid frequency_type.", 400);

    const result = await pool.query(
      `
      UPDATE care_reminders SET
        reminder_type   = COALESCE($1, reminder_type),
        title           = COALESCE($2, title),
        description     = COALESCE($3, description),
        frequency_type  = COALESCE($4, frequency_type),
        interval_value  = COALESCE($5, interval_value),
        next_due_at     = COALESCE($6, next_due_at),
        is_active       = COALESCE($7, is_active),
        updated_at      = NOW()
      WHERE id = $8
      RETURNING *
      `,
      [reminderType, title, description, frequencyType, intervalValue, nextDueAt, isActive, id]
    );

    return ok({ reminder: result.rows[0] });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to update reminder.", 400);
  }
}

// DELETE /api/reminders/:id
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id } = await params;

    const reminder = await getOwnedReminder(id, user.id);
    if (!reminder) return fail("Reminder not found.", 404);

    await pool.query(`DELETE FROM care_reminders WHERE id = $1`, [id]);

    return ok({ deleted: true });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to delete reminder.", 400);
  }
}