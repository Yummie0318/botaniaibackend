import { NextRequest } from "next/server";
import { fail, ok } from "@/lib/response";
import { registerSchema } from "@/modules/auth/auth.schema";
import { registerUser } from "@/modules/auth/auth.service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return fail("Invalid registration input.", 422, {
        issues: parsed.error.flatten(),
      });
    }

    const result = await registerUser(parsed.data);
    return ok(result, 201);
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : "Registration failed.",
      400
    );
  }
}