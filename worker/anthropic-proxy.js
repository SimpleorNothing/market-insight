/**
 * DA Market Insight — Anthropic 공용 키 프록시 (Cloudflare Worker)
 *
 * 목적: 미리 충전해 둔 공용 Anthropic API 키를 Worker secret에 보관하고,
 *       브라우저는 이 Worker를 통해 리포트를 생성한다. 키는 절대 클라이언트로 나가지 않는다.
 *
 * 필요한 환경 변수 / 시크릿 (wrangler.toml + `wrangler secret put`):
 *   - ANTHROPIC_API_KEY (secret, 필수): sk-ant-... 공용 충전 키
 *   - ALLOWED_ORIGINS   (var, 권장)  : 콤마로 구분한 허용 Origin 목록
 *                                       예) "https://simpleornothing.github.io,https://samsungda.net"
 *                                       비워두면 모든 Origin 허용(테스트용, 운영 비권장)
 *
 * 배포 방법은 worker/README.md 참고.
 */

// 남용 방지: 허용 모델과 토큰 상한을 고정한다.
const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5-20251001",
]);
const MAX_TOKENS_CAP = 2000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowOrigin = resolveAllowedOrigin(origin, env);
    const corsHeaders = buildCorsHeaders(allowOrigin);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "POST만 허용됩니다." }, 405, corsHeaders);
    }

    // Origin 검증 (ALLOWED_ORIGINS가 설정된 경우)
    if (env.ALLOWED_ORIGINS && !allowOrigin) {
      return json({ error: "허용되지 않은 Origin." }, 403, corsHeaders);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다." }, 500, corsHeaders);
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
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      return json({ error: "messages가 필요합니다." }, 400, corsHeaders);
    }
    const maxTokens = Math.min(Number(payload.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP);

    const upstreamBody = {
      model: payload.model,
      max_tokens: maxTokens,
      system: typeof payload.system === "string" ? payload.system : undefined,
      messages: payload.messages,
    };

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(upstreamBody),
      });
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

function resolveAllowedOrigin(origin, env) {
  if (!env.ALLOWED_ORIGINS) return origin || "*";
  const list = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : "";
}

function buildCorsHeaders(allowOrigin) {
  return {
    "Access-Control-Allow-Origin": allowOrigin || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
