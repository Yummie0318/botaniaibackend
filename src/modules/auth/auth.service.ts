import { pool } from "@/lib/db";
import { comparePassword, hashPassword, signToken } from "@/lib/auth";

export async function registerUser(input: {
  full_name: string;
  username: string;
  email: string;
  password: string;
}) {
  const email = input.email.toLowerCase().trim();

  // ── 1. Confirm the email was OTP-verified (and verification is recent) ──────
  const otpResult = await pool.query(
    `SELECT id FROM otp_verifications
     WHERE email = $1
       AND verified_at IS NOT NULL
       AND verified_at > NOW() - INTERVAL '30 minutes'
     LIMIT 1`,
    [email]
  );
  if (otpResult.rows.length === 0) {
    throw new Error(
      "Email is not verified. Please verify your email before registering."
    );
  }

  // ── 2. Guard against duplicate email ─────────────────────────────────────────
  const existingEmail = await pool.query(
    `SELECT id FROM app_users WHERE email = $1 LIMIT 1`,
    [email]
  );
  if (existingEmail.rows.length > 0) {
    throw new Error("Email is already registered.");
  }

  // ── 3. Guard against duplicate username ──────────────────────────────────────
  const existingUsername = await pool.query(
    `SELECT id FROM app_users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
    [input.username.trim()]
  );
  if (existingUsername.rows.length > 0) {
    throw new Error("Username is already taken.");
  }

  // ── 4. Create the user ───────────────────────────────────────────────────────
  const passwordHash = await hashPassword(input.password);

  const result = await pool.query(
    `INSERT INTO app_users (full_name, username, email, password_hash, auth_provider, role, status)
     VALUES ($1, $2, $3, $4, 'email', 'user', 'active')
     RETURNING id, full_name, username, email, role, created_at`,
    [input.full_name, input.username.trim(), email, passwordHash]
  );

  const user = result.rows[0];

  // ── 5. Initialise user settings ──────────────────────────────────────────────
  await pool.query(
    `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );

  // ── 6. Clean up OTP record ───────────────────────────────────────────────────
  await pool.query(`DELETE FROM otp_verifications WHERE email = $1`, [email]);

  // ── 7. Issue JWT ─────────────────────────────────────────────────────────────
  const token = signToken({ id: user.id, email: user.email, role: user.role });

  return { user, token };
}

export async function loginUser(input: { email: string; password: string }) {
  const result = await pool.query(
    `SELECT id, full_name, email, password_hash, role, status
     FROM app_users
     WHERE email = $1
     LIMIT 1`,
    [input.email.toLowerCase().trim()]
  );

  // Use the same generic error for both "not found" and "wrong password"
  // so we don't leak which emails are registered.
  const INVALID_CREDS = "Invalid email or password.";

  if (result.rows.length === 0) {
    throw new Error(INVALID_CREDS);
  }

  const user = result.rows[0];

  if (!user.password_hash) {
    throw new Error("This account uses a different sign-in method.");
  }

  const isValid = await comparePassword(input.password, user.password_hash);
  if (!isValid) {
    throw new Error(INVALID_CREDS);
  }

  if (user.status !== "active") {
    throw new Error("Your account is not active. Please contact support.");
  }

  await pool.query(
    `UPDATE app_users SET last_login_at = NOW() WHERE id = $1`,
    [user.id]
  );

  const token = signToken({ id: user.id, email: user.email, role: user.role });

  return {
    token,
    user: {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      role: user.role,
    },
  };
}