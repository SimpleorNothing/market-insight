/**
 * url-normalize.js 단위 테스트 — node test-url-normalize.mjs
 * 실패 시 exit 1 (커밋 전 검증용).
 */
import { normalizeUrl, sourceHeadlineKey } from "./url-normalize.js";

let pass = 0;
let fail = 0;

function eq(name, actual, expected) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name}\n  기대: ${expected}\n  실제: ${actual}`);
  }
}

function same(name, a, b) {
  eq(name, normalizeUrl(a), normalizeUrl(b));
}

function diff(name, a, b) {
  if (normalizeUrl(a) !== normalizeUrl(b)) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL(오병합): ${name}\n  둘 다: ${normalizeUrl(a)}`);
  }
}

// ── 같은 기사로 합쳐져야 하는 변형들 ──
same("http vs https", "http://news.example.com/a/1", "https://news.example.com/a/1");
same("www 유무", "https://www.example.com/a/1", "https://example.com/a/1");
same("amp 서브도메인", "https://amp.example.com/a/1", "https://example.com/a/1");
same("모바일 미러", "https://m.example.com/a/1", "https://example.com/a/1");
same("경로 /amp 접미", "https://example.com/a/1/amp", "https://example.com/a/1");
same("경로 /amp/ 접미", "https://example.com/a/1/amp/", "https://example.com/a/1");
same(".amp.html 변형", "https://example.com/a/1.amp.html", "https://example.com/a/1.html");
same("utm 추적 파라미터", "https://example.com/a?id=9&utm_source=x&utm_medium=y", "https://example.com/a?id=9");
same("fbclid", "https://example.com/a?fbclid=abc123", "https://example.com/a");
same("amp 쿼리", "https://example.com/a?id=9&amp=1&outputType=amp", "https://example.com/a?id=9");
same("파라미터 순서", "https://example.com/a?b=2&a=1", "https://example.com/a?a=1&b=2");
same("꼬리 슬래시", "https://example.com/a/1/", "https://example.com/a/1");
same("프래그먼트", "https://example.com/a#section2", "https://example.com/a");
same("연속 슬래시", "https://example.com//a///1", "https://example.com/a/1");

// ── 다른 기사로 유지되어야 하는 경우들 (오병합 방지) ──
diff("기사 ID 다름", "https://example.com/a?id=9", "https://example.com/a?id=10");
diff("경로 다름", "https://example.com/a/1", "https://example.com/a/2");
diff("도메인 다름", "https://alpha.com/a/1", "https://beta.com/a/1");
diff("의미있는 파라미터 유지", "https://example.com/view?aid=100", "https://example.com/view?aid=200");
diff("amp가 단어 일부인 경로", "https://example.com/campaign/1", "https://example.com/camp/1");

// ── 폴백·경계 ──
eq("빈 입력", normalizeUrl(""), "");
eq("null", normalizeUrl(null), "");
eq("URL 파싱 실패 폴백", normalizeUrl("not a url  "), "not a url");

// ── sourceHeadlineKey ──
eq(
  "동일 출처+헤드라인(공백 차이)",
  sourceHeadlineKey({ source: "매체A", headline: "삼성전자  신제품   공개" }),
  sourceHeadlineKey({ source: "매체A", headline: "삼성전자 신제품 공개" })
);
if (
  sourceHeadlineKey({ source: "매체A", headline: "삼성전자 신제품 공개" }) ===
  sourceHeadlineKey({ source: "매체B", headline: "삼성전자 신제품 공개" })
) {
  fail++;
  console.error("FAIL: 다른 출처 동일 헤드라인이 같은 키로 병합됨");
} else {
  pass++;
}
eq("헤드라인 없음", sourceHeadlineKey({ source: "매체A", headline: "" }), "");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
