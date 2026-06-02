import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
import { env } from "./env";
import { pool } from "./db";

export type JwtUser = {
  id: string;
  email: string;
  role: string;
};

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: JwtUser) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "30d" });
}

export function verifyToken(token: string): JwtUser {
  return jwt.verify(token, env.jwtSecret) as JwtUser;
}

export function getTokenFromRequest(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;

  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) return null;

  return token;
}

export async function requireAuth(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (!token) {
    throw new Error("Unauthorized");
  }

  const decoded = verifyToken(token);

  const result = await pool.query(
    `
    SELECT id, email, role, status
    FROM app_users
    WHERE id = $1
    LIMIT 1
    `,
    [decoded.id]
  );

  if (result.rows.length === 0) {
    throw new Error("Unauthorized");
  }

  const user = result.rows[0];

  if (user.status !== "active") {
    throw new Error("Account is not active");
  }

  return user as JwtUser & { status: string };
}