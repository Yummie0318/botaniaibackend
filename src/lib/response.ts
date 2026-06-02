import { NextResponse } from "next/server";

export function ok(data: unknown, status = 200) {
  return NextResponse.json(
    typeof data === "object" && data !== null
      ? { success: true, ...data }
      : { success: true, data },
    { status }
  );
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json(
    {
      success: false,
      error: message,
      ...(extra ?? {}),
    },
    { status }
  );
}