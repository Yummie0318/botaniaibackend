import OpenAI from "openai";
import { env } from "./env";

export const openai = env.openaiApiKey
  ? new OpenAI({ apiKey: env.openaiApiKey })
  : null;