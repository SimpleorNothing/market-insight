import { extractIdToken, checkLinkAlive } from "./fetch-news.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "✓" : "✗"} ${name}  got=${got} want=${want}`);
  ok ? pass++ : fail++;
};

// --- extractIdToken: 실제 URL 형태 ---
eq("bizwatch 순번", extractIdToken("https://news.bizwatch.co.kr/article/industry/2026/07/07/0020"), "0020");
eq("idxno", extractIdToken("https://www.electimes.com/news/articleView.html?idxno=369972"), "369972");
eq("msn ar-", extractIdToken("https://www.msn.com/en-us/money/x/ar-AA1UiepA?apiversion=v2"), "ar-AA1UiepA");
eq("daum 숫자", extractIdToken("https://v.daum.net/v/20260704050237686"), "20260704050237686");
eq("donga path 숫자", extractIdToken("https://www.donga.com/news/amp/all/20260706/134247144/2"), "134247144");
eq("토큰없음", extractIdToken("https://example.com/"), null);

// --- checkLinkAlive: fetch 목킹으로 판정 테이블 검증 ---
const mock = (status, finalUrl, throwCode) => {
  global.fetch = async () => {
    if (throwCode) { const e = new Error("net"); e.cause = { code: throwCode }; throw e; }
    return { status, url: finalUrl, text: async () => "" };
  };
};
const REQ = "https://news.bizwatch.co.kr/article/industry/2026/07/07/0020";

mock(200, REQ);                     eq("200 그대로=alive", await checkLinkAlive(REQ), "alive");
mock(404, REQ);                     eq("404=dead", await checkLinkAlive(REQ), "dead");
mock(410, REQ);                     eq("410=dead", await checkLinkAlive(REQ), "dead");
mock(200, "https://news.bizwatch.co.kr/article/include/error"); eq("soft404 식별자유실=dead", await checkLinkAlive(REQ), "dead");
mock(200, "https://news.bizwatch.co.kr/");                       eq("루트로 튕김=dead", await checkLinkAlive(REQ), "dead");
mock(403, REQ);                     eq("403 봇차단=unknown(보존)", await checkLinkAlive(REQ), "unknown");
mock(429, REQ);                     eq("429=unknown(보존)", await checkLinkAlive(REQ), "unknown");
mock(500, REQ);                     eq("500=unknown(보존)", await checkLinkAlive(REQ), "unknown");
mock(0, null, "ENOTFOUND");         eq("DNS소멸=dead", await checkLinkAlive(REQ), "dead");
mock(0, null, "ECONNREFUSED");      eq("연결거부=dead", await checkLinkAlive(REQ), "dead");
global.fetch = async () => { const e = new Error("t"); e.name = "AbortError"; throw e; };
eq("타임아웃=unknown(보존)", await checkLinkAlive(REQ), "unknown");

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
