import { env } from "./env";

export async function callAI(prompt: string): Promise<string | null> {
  // Try OpenRouter first
  if (env.openRouterApiKey) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.openRouterApiKey}`,
          "HTTP-Referer": "https://botaniai.app",
          "X-Title": "BotaniAI",
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          max_tokens: 1000,
          temperature: 0.3,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content || null;
        if (text) {
          console.log("=== AI RESPONSE (OpenRouter) ===", text);
          return text;
        }
      } else {
        console.error("OpenRouter error:", response.status, await response.text());
      }
    } catch (err) {
      console.error("OpenRouter fetch failed:", err);
    }
  }

  // Fallback to Gemini if OpenRouter fails
  if (env.geminiApiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent?key=${env.geminiApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (text) {
          console.log("=== AI RESPONSE (Gemini fallback) ===", text);
          return text;
        }
      } else {
        console.error("Gemini fallback error:", response.status, await response.text());
      }
    } catch (err) {
      console.error("Gemini fallback fetch failed:", err);
    }
  }

  console.error("=== ALL AI PROVIDERS FAILED ===");
  return null;
}