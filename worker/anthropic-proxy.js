/**
 * DA Market Insight — Gemini 공용 키 프록시 (Cloudflare Worker)
 *
 * 목적: 공용 Gemini API 키를 Worker secret에 보관하고,
 *       브라우저는 이 Worker를 통해 리포트를 생성한다. 키는 절대 클라이언트로 나가지 않는다.
 *
 * 필요한 환경 변수 / 시크릿 (wrangler.toml + `wrangler secret put`):
 *   - GEMINI_API_KEY 또는 GOOGLE_API_KEY (secret, 필수)
 *   - ALLOWED_ORIGINS   (var, 권장)  : 콤마로 구분한 허용 Origin 목록
 *                                       예) "https://simpleornothing.github.io,https://samsungda.net"
 *                                       비워두면 모든 Origin 허용(테스트용, 운영 비권장)
 *
 * 배포 방법은 worker/README.md 참고.
 */

// 남용 방지: 허용 모델과 토큰 상한을 고정한다.
const ALLOWED_MODELS = new Set([
  "gemini-3.6-flash",
]);
const MAX_TOKENS_CAP = 2000;

export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders();

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "POST만 허용됩니다." }, 405, corsHeaders);
    }

    const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (!apiKey) {
      return json({ error: "서버에 GEMINI_API_KEY 또는 GOOGLE_API_KEY가 설정되지 않았습니다." }, 500, corsHeaders);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "잘못된 JSON 본문." }, 400, corsHeaders);
    }

    // 입력 검증 + 남용 방지 (모델 화이트리스트, 토큰 상한)
    if (!ALLOWED_MODELS.has(payload.model)) {
      return json({ error: "허용되지 않은 model." }, 400, corsHeaders);
    }
    if (!Array.isArray(payload.contents) || payload.contents.length === 0) {
      return json({ error: "contents가 필요합니다." }, 400, corsHeaders);
    }
    const maxTokens = Math.min(
      Number(payload.generationConfig?.maxOutputTokens) || MAX_TOKENS_CAP,
      MAX_TOKENS_CAP
    );

    const upstreamBody = {
      systemInstruction: payload.systemInstruction,
      contents: payload.contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
      },
    };

    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${payload.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(upstreamBody),
        }
      );
    } catch (err) {
      return json({ error: "업스트림 호출 실패: " + (err?.message || err) }, 502, corsHeaders);
    }

    // 업스트림 응답을 그대로 전달 (CORS 헤더만 부착)
    const respBody = await upstream.text();
    return new Response(respBody, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  },
};

function buildCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
