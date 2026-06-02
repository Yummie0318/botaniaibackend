import { pool } from "@/lib/db";
import { comparePassword, hashPassword, signToken } from "@/lib/auth";

export async function registerUser(input: {
  full_name: string;
  email: string;
  password: string;
}) {
  const existing = await pool.query(
    `SELECT id FROM app_users WHERE email = $1 LIMIT 1`,
    [input.email]
  );

  if (existing.rows.length > 0) {
    throw new Error("Email is already registered.");
  }

  const passwordHash = await hashPassword(input.password);

  const result = await pool.query(
    `
    INSERT INTO app_users (
      full_name,
      email,
      password_hash,
      auth_provider,
      role,
      status
    )
    VALUES ($1, $2, $3, 'email', 'user', 'active')
    RETURNING id, full_name, email, role, created_at
    `,
    [input.full_name, input.email, passwordHash]
  );

  const user = result.rows[0];

  await pool.query(
    `
    INSERT INTO user_settings (user_id)
    VALUES ($1)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [user.id]
  );

  const token = signToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

  return { user, token };
}

export async function loginUser(input: {
  email: string;
  password: string;
}) {
  const result = await pool.query(
    `
    SELECT id, full_name, email, password_hash, role, status
    FROM app_users
    WHERE email = $1
    LIMIT 1
    `,
    [input.email]
  );

  if (result.rows.length === 0) {
    throw new Error("Invalid email or password.");
  }

  const user = result.rows[0];

  if (!user.password_hash) {
    throw new Error("This account cannot log in with password.");
  }

  const isValid = await comparePassword(input.password, user.password_hash);
  if (!isValid) {
    throw new Error("Invalid email or password.");
  }

  if (user.status !== "active") {
    throw new Error("Account is not active.");
  }

  await pool.query(
    `UPDATE app_users SET last_login_at = NOW() WHERE id = $1`,
    [user.id]
  );

  const token = signToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

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