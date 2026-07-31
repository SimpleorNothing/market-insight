/**
 * URL 정규화 유틸 — 사전 중복제거(dedupeAndFilter) 키 생성 전용
 *
 * 같은 기사가 AMP 변형·추적 파라미터·모바일 미러 URL 등으로 재유입되어
 * LLM 분류가 중복 호출되는 것을 차단한다 (입력 토큰 비용 절감, PR #91 후속).
 *
 * 주의: 표시·저장용 URL은 절대 변형하지 않는다. 오직 dedup 해시 키
 * 계산 시에만 사용한다. 정규화가 과격하면 서로 다른 기사를 오병합할 수
 * 있으므로 규칙은 보수적으로 유지한다 (확실한 변형 패턴만 제거).
 */

// 콘텐츠 식별과 무관한 추적 파라미터 (제거해도 같은 문서)
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "cmpid",
  "ncid",
  "ref_src",
]);

// AMP 렌더링 지시 파라미터 (제거해도 같은 문서)
const AMP_QUERY_KEYS = new Set(["amp", "outputtype", "amp_js_v", "usqp"]);

/**
 * dedup 키용 URL 정규화.
 * - 프로토콜 http→https 통일, 호스트 소문자화
 * - www. / amp. / m. 서브도메인 접두 제거
 * - 경로의 /amp 접미·접두, .amp.html 변형 제거, 연속 슬래시·꼬리 슬래시 정리
 * - 추적·AMP 파라미터 제거, 잔여 파라미터 키 기준 정렬(순서 차이 무력화)
 * - 프래그먼트(#...) 제거
 * URL 파싱 실패 시 원문 trim+소문자로 폴백(기존 동작과 동일한 완전일치 수준).
 */
export function normalizeUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }

  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  else if (host.startsWith("amp.")) host = host.slice(4);
  else if (host.startsWith("m.")) host = host.slice(2);

  let path = u.pathname
    .replace(/\/+/g, "/")
    .replace(/^\/amp\//i, "/")
    .replace(/\/amp\/?$/i, "")
    .replace(/\.amp(\.html?)$/i, "$1")
    .replace(/\.amp$/i, "");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path) path = "/";

  const params = [];
  for (const [k, v] of u.searchParams) {
    const kl = k.toLowerCase();
    if (TRACKING_PARAMS.has(kl)) continue;
    if (AMP_QUERY_KEYS.has(kl)) continue;
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const q = params.length
    ? "?" + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
    : "";

  const proto = u.protocol === "http:" ? "https:" : u.protocol;
  return `${proto}//${host}${path}${q}`;
}

/**
 * 같은 출처가 같은 헤드라인을 다른 URL로 재발행한 경우(재송고·URL 개편)를
 * 잡는 보조 키. 출처가 다르면 키가 달라지므로 서로 다른 매체의 동일 사건
 * 보도는 제거하지 않는다 — 그건 분류 후 dedupeMerged(관련기사 접기)의 몫.
 * (기존 적재분의 headline은 분류기가 재작성한 것이라 원문 헤드라인과 달라
 *  소급 비교가 불가하므로, 이 키는 동일 실행 내(fresh 간)에서만 사용한다.)
 */
export function sourceHeadlineKey(item) {
  const h = (item.headline || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!h) return "";
  return `${(item.source || "").trim()}\u0000${h}`;
}
