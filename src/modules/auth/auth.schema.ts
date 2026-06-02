import { z } from "zod";

export const registerSchema = z.object({
  full_name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(6).max(100),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(100),
});