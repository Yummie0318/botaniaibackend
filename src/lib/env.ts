export const env = {
  databaseUrl: process.env.DATABASE_URL!,
  jwtSecret: process.env.JWT_SECRET!,
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  plantnetApiKey: process.env.PLANTNET_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
};

const required = ["DATABASE_URL", "JWT_SECRET"] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}