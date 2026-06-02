import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

type Params = { params: Promise<{ id: string; plantId: string }> };

// GET /api/gardens/:id/plants/:plantId/reminders
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: gardenId, plantId } = await params;

    // Verify plant belongs to this garden and user
    const plantCheck = await pool.query(
      `SELECT id FROM garden_plants WHERE id = $1 AND garden_id = $2 AND user_id = $3 LIMIT 1`,
      [plantId, gardenId, user.id]
    );
    if (plantCheck.rows.length === 0) return fail("Plant not found.", 404);

    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("active") !== "false";

    const result = await pool.query(
      `
      SELECT * FROM care_reminders
      WHERE garden_plant_id = $1
      ${activeOnly ? "AND is_active = true" : ""}
      ORDER BY next_due_at ASC
      `,
      [plantId]
    );

    return ok({ reminders: result.rows });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch reminders.", 400);
  }
}

// POST /api/gardens/:id/plants/:plantId/reminders
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const user = await requireAuth(request);
    const { id: gardenId, plantId } = await params;
    const body = await request.json();

    // Verify plant belongs to this garden and user
    const plantCheck = await pool.query(
      `SELECT id FROM garden_plants WHERE id = $1 AND garden_id = $2 AND user_id = $3 LIMIT 1`,
      [plantId, gardenId, user.id]
    );
    if (plantCheck.rows.length === 0) return fail("Plant not found.", 404);

    const reminderType = typeof body.reminder_type === "string" ? body.reminder_type.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : null;
    const frequencyType = typeof body.frequency_type === "string" ? body.frequency_type.trim() : "";
    const intervalValue = typeof body.interval_value === "number" ? body.interval_value : null;
    const nextDueAt = typeof body.next_due_at === "string" ? body.next_due_at : null;

    if (!title) return fail("title is required.", 400);
    if (!nextDueAt) return fail("next_due_at is required.", 400);

    const validReminderTypes = ["watering", "fertilizing", "pruning", "repotting", "custom"];
    const validFrequencyTypes = ["once", "daily", "weekly", "monthly", "custom"];

    if (!validReminderTypes.includes(reminderType)) return fail("Invalid reminder_type.", 400);
    if (!validFrequencyTypes.includes(frequencyType)) return fail("Invalid frequency_type.", 400);

    if (frequencyType === "custom" && !intervalValue) {
      return fail("interval_value is required for custom frequency.", 400);
    }

    const result = await pool.query(
      `
      INSERT INTO care_reminders
        (garden_plant_id, reminder_type, title, description, frequency_type, interval_value, next_due_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [plantId, reminderType, title, description, frequencyType, intervalValue, nextDueAt]
    );

    return ok({ reminder: result.rows[0] }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to create reminder.", 400);
  }
}