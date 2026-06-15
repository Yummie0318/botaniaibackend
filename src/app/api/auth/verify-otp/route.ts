// src/app/api/auth/verify-otp/route.ts
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";
import { verifyOtpSchema } from "@/modules/auth/auth.schema";
import { NextRequest } from "next/server";

// Track failed attempts per email to prevent brute-force guessing.
// Replace with Redis for multi-instance deployments.
const attemptMap = new Map<string, { count: number; since: number }>();
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isBruteForced(email: string): boolean {
  const now = Date.now();
  const record = attemptMap.get(email);

  if (!record || now - record.since > ATTEMPT_WINDOW_MS) {
    attemptMap.set(email, { count: 1, since: now });
    return false;
  }

  if (record.count >= MAX_ATTEMPTS) return true;

  record.count += 1;
  return false;
}

function clearAttempts(email: string) {
  attemptMap.delete(email);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // ── Validate input ────────────────────────────────────────────────────────
    const parsed = verifyOtpSchema.safeParse(body);
    if (!parsed.success) {
      return fail(parsed.error.issues[0].message, 400);
    }

    const email = parsed.data.email.toLowerCase().trim();
    const code = parsed.data.code.trim();

    // ── Brute-force guard ─────────────────────────────────────────────────────
    if (isBruteForced(email)) {
      return fail(
        "Too many failed attempts. Please request a new verification code.",
        429
      );
    }

    // ── Look up valid, unverified OTP ─────────────────────────────────────────
    const result = await pool.query(
      `SELECT id FROM otp_verifications
       WHERE email = $1
         AND code = $2
         AND verified_at IS NULL
         AND expires_at > NOW()
       LIMIT 1`,
      [email, code]
    );

    if (result.rows.length === 0) {
      return fail("Invalid or expired verification code.", 400);
    }

    // ── Mark as verified ──────────────────────────────────────────────────────
    await pool.query(
      `UPDATE otp_verifications SET verified_at = NOW() WHERE id = $1`,
      [result.rows[0].id]
    );

    clearAttempts(email); // reset on success

    return ok({ message: "Email verified successfully.", verified: true });
  } catch (error) {
    console.error("[verify-otp]", error);
    return fail(
      error instanceof Error ? error.message : "Failed to verify code.",
      500
    );
  }
}