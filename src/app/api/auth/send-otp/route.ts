// src/app/api/auth/send-otp/route.ts
import { pool } from "@/lib/db";
import { sendOtpEmail } from "@/lib/resend";
import { fail, ok } from "@/lib/response";
import { sendOtpSchema } from "@/modules/auth/auth.schema";
import { NextRequest } from "next/server";

// In-memory rate limit: max 3 OTP requests per email per 10 minutes.
// For production at scale, replace with Redis (e.g. Upstash).
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isRateLimited(email: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(email);

  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(email, { count: 1, windowStart: now });
    return false;
  }

  if (record.count >= RATE_LIMIT_MAX) return true;

  record.count += 1;
  return false;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // ── Validate input ────────────────────────────────────────────────────────
    const parsed = sendOtpSchema.safeParse(body);
    if (!parsed.success) {
      return fail(parsed.error.issues[0].message, 400);
    }

    const email = parsed.data.email.toLowerCase().trim();

    // ── Rate limit ────────────────────────────────────────────────────────────
    if (isRateLimited(email)) {
      return fail(
        "Too many verification requests. Please wait 10 minutes before trying again.",
        429
      );
    }

    // ── Block already-registered emails ───────────────────────────────────────
    const existing = await pool.query(
      `SELECT id FROM app_users WHERE email = $1 LIMIT 1`,
      [email]
    );
    if (existing.rows.length > 0) {
      return fail("An account with this email already exists.", 400);
    }

    // ── Generate & persist OTP ────────────────────────────────────────────────
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Remove any previous unverified OTP for this email
    await pool.query(`DELETE FROM otp_verifications WHERE email = $1`, [email]);

    await pool.query(
      `INSERT INTO otp_verifications (email, code, expires_at)
       VALUES ($1, $2, $3)`,
      [email, code, expiresAt]
    );

    // ── Send email ────────────────────────────────────────────────────────────
    await sendOtpEmail(email, code);

    return ok({ message: "Verification code sent. Please check your inbox." });
  } catch (error) {
    console.error("[send-otp]", error);
    return fail(
      error instanceof Error ? error.message : "Failed to send verification code.",
      500
    );
  }
}