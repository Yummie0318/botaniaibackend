import { NextRequest } from "next/server";
import { fail, ok } from "@/lib/response";
import { loginSchema } from "@/modules/auth/auth.schema";
import { loginUser } from "@/modules/auth/auth.service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return fail("Invalid login input.", 422, {
        issues: parsed.error.flatten(),
      });
    }

    const result = await loginUser(parsed.data);
    return ok(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Login failed.", 400);
  }
}