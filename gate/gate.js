// gate.js — 사이트 접근 비밀번호 게이트 (포탈 samsungda-portal과 세션 공유)
//
// 포탈과 "동일한 3규칙"을 복제해 SSO에 편입한다:
//   1) 같은 SITE_PASSWORD secret 값
//   2) 같은 토큰 파생: HMAC(SITE_PASSWORD, "da-portal-auth-v1")
//   3) 같은 쿠키: da_portal_session, Domain=.samsungda.net, 약 180일
// → 포탈(또는 다른 도구)에서 로그인했으면 재입력 없이 통과하고,
//   여기서 로그인해도 다른 도구에 그대로 통한다.
//   비밀번호를 바꾸면 파생 토큰이 달라져 기존 쿠키가 전부 자동 무효화된다.
//
// SITE_PASSWORD 미설정 시 게이트는 비활성(사이트 공개) — 잠금 사고 방지.
//   npx wrangler secret put SITE_PASSWORD   # 포탈과 "같은 값"

const AUTH_COOKIE = "da_portal_session";
const AUTH_MSG = "da-portal-auth-v1";
const AUTH_MAX_AGE = 60 * 60 * 24 * 180; // 약 180일
const SUBMIT_PATH = "/__auth";

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

// samsungda.net 영역에서만 Domain=.samsungda.net 을 붙여 서브도메인 간 세션을 공유한다.
// 로컬(localhost)·*.workers.dev 미리보기에서는 Domain을 생략(브라우저 거부 방지).
function cookieDomainAttr(hostname) {
  return hostname === "samsungda.net" || hostname.endsWith(".samsungda.net")
    ? "; Domain=.samsungda.net"
    : "";
}

// 오픈 리다이렉트 차단 — 같은 출처 경로만 허용.
function safeNextPath(next) {
  if (typeof next !== "string" || !next) return "/";
  if (next[0] !== "/" || next[1] === "/") return "/";
  if (next.indexOf(SUBMIT_PATH) === 0) return "/";
  return next;
}

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function sessionToken(env) {
  return hmacHex(env.SITE_PASSWORD, AUTH_MSG);
}

async function isAuthed(request, env) {
  const cookie = parseCookies(request.headers.get("cookie"))[AUTH_COOKIE];
  if (!cookie) return false;
  return timingSafeEqual(cookie, await sessionToken(env));
}

function cookieHeader(token, url) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return (
    AUTH_COOKIE + "=" + token + "; Path=/; Max-Age=" + AUTH_MAX_AGE +
    "; HttpOnly; SameSite=Lax" + cookieDomainAttr(url.hostname) + secure
  );
}

function loginPage(title, next, isError) {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escAttr(title)} — 로그인</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
  :root{--bg:#fff;--surface:#f6f7f9;--text:#1a1d21;--muted:#5b6470;--border:#e6e9ee;--brand:#1257d6}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Pretendard',system-ui,-apple-system,'Segoe UI',Roboto,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:var(--text);background:var(--bg);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .login{width:100%;max-width:360px;background:var(--surface);border:1.5px solid var(--border);border-radius:14px;padding:32px 28px}
  h1{font-size:22px;font-weight:800;letter-spacing:-.5px;margin-bottom:8px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:22px}
  input[type=password]{width:100%;font:inherit;font-size:15px;padding:12px 14px;border:1.5px solid var(--border);border-radius:10px;background:#fff;outline:none}
  input[type=password]:focus{border-color:var(--brand)}
  button{width:100%;margin-top:14px;font:inherit;font-size:15px;font-weight:700;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:12px 14px;cursor:pointer}
  .err{color:#c0392b;font-size:13px;margin-bottom:14px}
</style>
</head>
<body>
  <form class="login" method="POST" action="${SUBMIT_PATH}">
    <h1>${escAttr(title)}</h1>
    <p class="sub">계속하려면 기획 도구 모음 공통 비밀번호를 입력하세요.</p>
    ${isError ? '<p class="err">비밀번호가 올바르지 않습니다.</p>' : ""}
    <input type="hidden" name="next" value="${escAttr(next)}">
    <input type="password" name="password" autocomplete="current-password" autofocus>
    <button type="submit">입장</button>
  </form>
</body>
</html>`;
  return new Response(html, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleLogin(request, env, url, title) {
  let pw = "";
  let dest = "/";
  try {
    const form = await request.formData();
    pw = String(form.get("password") || "");
    dest = safeNextPath(String(form.get("next") || "/"));
  } catch {
    pw = "";
  }
  if (pw && timingSafeEqual(pw, String(env.SITE_PASSWORD))) {
    return new Response(null, {
      status: 303,
      headers: { "set-cookie": cookieHeader(await sessionToken(env), url), location: dest },
    });
  }
  return loginPage(title, dest, true);
}

// 게이트 통과면 null, 막히면 Response(로그인 페이지 또는 로그인 처리 결과)를 돌려준다.
//   options.title     로그인 화면 제목
//   options.openPaths 게이트를 적용하지 않을 경로 프리픽스(기계 소비용 공개 데이터 등)
export async function guard(request, env, url, options = {}) {
  if (!env.SITE_PASSWORD) return null; // 미설정 시 공개(잠금 사고 방지)

  const title = options.title || "기획 도구 모음";
  if (url.pathname === SUBMIT_PATH && request.method === "POST") {
    return handleLogin(request, env, url, title);
  }
  if (await isAuthed(request, env)) return null;

  const open = options.openPaths || [];
  if (open.some((p) => url.pathname === p || url.pathname.startsWith(p))) return null;

  return loginPage(title, url.pathname + (url.search || ""), false);
}
