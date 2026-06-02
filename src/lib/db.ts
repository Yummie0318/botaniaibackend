import { Pool } from "pg";
import { env } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __botaniaiPool: Pool | undefined;
}

export const pool =
  global.__botaniaiPool ??
  new Pool({
    connectionString: env.databaseUrl,
ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

if (process.env.NODE_ENV !== "production") {
  global.__botaniaiPool = pool;
}