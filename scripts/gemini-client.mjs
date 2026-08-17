const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const GEMINI_FLASH_LITE_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_FLASH_MODEL = "gemini-3.6-flash";

const usageStats = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export function getGeminiUsageStats() {
  return { ...usageStats };
}

export function geminiApiKey(env = process.env) {
  return String(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
}

export async function generateGemini({
  apiKey,
  model,
  systemText = "",
  parts,
  maxOutputTokens,
}) {
  if (!apiKey) throw new Error("GEMINI_API_KEY 또는 GOOGLE_API_KEY 미설정");
  if (!model) throw new Error("Gemini 모델 미지정");
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Gemini 요청 parts가 비어 있습니다");
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens,
      responseMimeType: "application/json",
    },
  };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 500)}`);
  }

  const data = await res.json();
  const usage = data.usageMetadata || {};
  usageStats.calls += 1;
  usageStats.inputTokens += Number(usage.promptTokenCount || 0);
  usageStats.outputTokens += Number(usage.candidatesTokenCount || 0);
  usageStats.totalTokens += Number(usage.totalTokenCount || 0);
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason || "empty_response";
    throw new Error(`Gemini 응답 텍스트 없음: ${reason}`);
  }
  return text;
}
