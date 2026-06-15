import { z } from "zod";

export const sendOtpSchema = z.object({
  email: z.string().email("Invalid email address."),
});

export const verifyOtpSchema = z.object({
  email: z.string().email("Invalid email address."),
  code: z.string().length(6, "Code must be exactly 6 digits.").regex(/^\d{6}$/, "Code must be numeric."),
});

// otp_code is NOT included here — registration only requires the email was
// previously verified. The backend confirms verification via the DB, not by
// re-accepting the raw code from the client (which would be a security risk).
export const registerSchema = z.object({
  full_name: z.string().min(2, "Full name must be at least 2 characters.").max(120),
  username: z
    .string()
    .min(3, "Username must be at least 3 characters.")
    .max(30)
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Username can only contain letters, numbers, and underscores."
    ),
  email: z.string().email("Invalid email address."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(100)
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter.")
    .regex(/[0-9]/, "Password must contain at least one number."),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address."),
  password: z.string().min(6).max(100),
});