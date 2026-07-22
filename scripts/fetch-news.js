#!/usr/bin/env node
/**
 * DA Market Insight 뉴스 수집·분류 스크립트 (v2)
 *
 * v2 변경 사항:
 *   - 신호 라벨 폐지 → 영향도 점수(1~5) + 액션 등급(긴급/주요/주시/참고)
 *   - 사업부 분류 폐지 → 제품 7개 + 경쟁사 12개 다중 태그
 *   - 영향도 4 인자 산출 (매출비중/시간긴급성/시장규모/출처신뢰도)
 *   - 등급 자동 매핑 (점수 임계값 기반)
 *
 * 환경변수:
 *   ANTHROPIC_API_KEY (필수)
 *   DRY_RUN=1 (선택)
 */

import Anthropic from "@anthropic-ai/sdk";
import { isPortraitImage, pickTopicImage } from "./detect-portrait.mjs";
import Parser from "rss-parser";
import { readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CONFIG = JSON.parse(
  await readFile(join(__dirname, "config.json"), "utf-8")
);

// 수동 큐레이션 + 기업명 오역 가드 (선택 파일). 없으면 빈 설정으로 동작.
const CURATION_CFG = await readFile(join(__dirname, "curation.json"), "utf-8")
  .then((t) => JSON.parse(t))
  .catch(() => ({}));

const NEWS_PATH = join(ROOT, "data", "news.json");
const DRY_RUN = process.env.DRY_RUN === "1";
const RUN_DATE = new Date().toISOString().slice(0, 10);

const client = DRY_RUN
  ? null
  : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const rssParser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "DA-Market-Insight/2.0" },
});

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ===== Utilities =====
function urlHash(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

function gradeFromImpact(impact) {
  const t = CONFIG.gradeThresholds;
  if (impact >= t["긴급"]) return "긴급";
  if (impact >= t["주요"]) return "주요";
  if (impact >= t["주시"]) return "주시";
  return "참고";
}

function isWithinRetention(publishedAt, grade) {
  const days = CONFIG.retention[grade] ?? 14;
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  return ageMs / (1000 * 60 * 60 * 24) <= days;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function isBlockedByKeyword(headline) {
  const lower = headline.toLowerCase();
  // 통상·관세 정책 키워드가 있으면 차단하지 않고 분류 단계로 넘김
  // (역외 생산 비중이 높은 당사 특성상 보호무역 정책은 밀착 모니터링 대상)
  for (const kw of CONFIG.filterRules.allowOverrideKeywords || []) {
    if (headline.includes(kw) || lower.includes(kw.toLowerCase())) {
      return null;
    }
  }
  for (const kw of CONFIG.filterRules.blockKeywords) {
    if (headline.includes(kw) || lower.includes(kw.toLowerCase())) {
      return kw;
    }
  }
  return null;
}

function computeImpact(factors) {
  const w = CONFIG.impactWeights;
  const score =
    factors.salesRelevance * w.salesRelevance +
    factors.timeUrgency * w.timeUrgency +
    factors.marketSize * w.marketSize +
    factors.sourceReliability * w.sourceReliability;
  return Math.round(score * 10) / 10;
}

// ===== 제목·내용 유사도 (중복 기사 묶음용) =====
function normForSim(s) {
  return String(s || "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
}

// 같은 회사의 표기 변형을 하나로 통일해 유사도 비교 정확도를 높인다.
// (예: "현대E&C" → normForSim 후 "현대ec" → "현대건설")
const ORG_CANON = [
  [/현대이앤씨|현대ec|hyundaiec|hyundaiengineering|hdec/g, "현대건설"],
  [/현대자동차|hyundaimotor/g, "현대차"],
  [/gsec|gs이앤씨/g, "gs건설"],
  [/daewooec|대우이앤씨/g, "대우건설"],
  [/lgelectronics/g, "lg전자"],
  [/samsungelectronics/g, "삼성전자"],
  [/samsungct|삼성씨앤티/g, "삼성물산"],
];

function canonForSim(s) {
  let t = normForSim(s);
  for (const [re, to] of ORG_CANON) t = t.replace(re, to);
  return t;
}

function pointsText(it) {
  return (it.summaryPoints || [])
    .map((p) => (p && p.text) || "")
    .filter(Boolean)
    .join(" ");
}

function bigramSet(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function sharesEntity(a, b) {
  const setA = new Set([...(a.competitors || []), ...(a.products || [])]);
  return [...(b.competitors || []), ...(b.products || [])].some((x) =>
    setA.has(x)
  );
}

// ===== 같은 사건 묶음: 대표 기사에 접어 보존할 관련기사 항목 =====
// news.json 비대화를 막기 위해 헤드라인·URL·출처만 담은 경량 스냅샷을 저장한다.
// url 기준 dedup 키(없으면 id). 이미 관련기사 형태로 접힌 항목에도 idempotent 하게 동작.
function relatedKey(it) {
  return String((it && (it.url || it.id)) || "").trim();
}
function toRelated(it) {
  return {
    id: it.id,
    headline: it.headline,
    url: it.url || it.source?.url || "",
    source: { name: it.source?.name || "" },
    publishedAt: it.publishedAt,
  };
}

// ===== Google News URL 디코딩 =====
// Google News의 /articles/{id} 리다이렉트는 일부 사내망에서 차단·리다이렉션 오류를 일으킴.
// batchexecute 내부 API로 실제 발행처 URL을 미리 해석해 둠.
function isGoogleNewsUrl(url) {
  return /^https?:\/\/news\.google\.com\/(?:rss\/)?articles\//.test(url || "");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// /rss/articles/{id} 페이지에는 대상 기사 外에도 "관련기사" 등 다른 기사 카드가
// 함께 렌더링되며, 각 카드는 자신만의 data-n-a-id/-sg/-ts 트리플을 갖는다.
// 과거에는 페이지 전체에서 첫 번째 sg/ts만 취했는데, 그 첫 매치가 대상 기사가 아닌
// 다른(관련) 기사 카드일 경우 garturlreq가 엉뚱한 기사의 URL을 반환해 클릭 시
// 완전히 다른 기사로 연결되는 버그가 있었다. 반드시 대상 base64ArticleId를 가진
// 태그 자신의 sg/ts를 찾아야 한다.
function extractSignatureForId(html, targetId) {
  const tagRe = /<[a-zA-Z][^>]*\bdata-n-a-id="([^"]+)"[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[1] !== targetId) continue;
    const tag = m[0];
    const sigM = tag.match(/data-n-a-sg="([^"]+)"/);
    const tsM = tag.match(/data-n-a-ts="([^"]+)"/);
    if (sigM && tsM) {
      return { signature: sigM[1], timestamp: Number(tsM[1]) };
    }
  }
  return null;
}

async function decodeGoogleNewsUrl(url) {
  if (!isGoogleNewsUrl(url)) return url;
  try {
    const idMatch = url.match(/\/articles\/([^?\/]+)/);
    if (!idMatch) return url;
    const base64ArticleId = idMatch[1];

    // 서명·타임스탬프는 /rss/articles 페이지의 c-wiz 속성에서 얻는다.
    const pageRes = await fetchWithTimeout(
      `https://news.google.com/rss/articles/${base64ArticleId}`,
      { headers: { "User-Agent": BROWSER_UA }, redirect: "follow" }
    );
    if (!pageRes.ok) return url;
    const html = await pageRes.text();

    let signature, timestamp;
    const scoped = extractSignatureForId(html, base64ArticleId);
    if (scoped) {
      ({ signature, timestamp } = scoped);
    } else {
      // 대상 id를 가진 태그를 페이지에서 찾지 못한 경우(레이아웃 변경 等) — 다른
      // 기사로 잘못 연결될 위험을 감수하느니 변환을 포기하고 원본(Google News) 링크를
      // 그대로 반환한다. 원본 링크는 리다이렉트되므로 최소한 오배송은 없다.
      log(`  ! ${base64ArticleId} 대상 서명 태그 미발견 → 변환 스킵(원본 링크 유지)`);
      return url;
    }

    // garturlreq에는 URL의 base64 article id를 그대로 넣는다(data-n-a-id 아님).
    const innerJson = JSON.stringify([
      "garturlreq",
      [
        [
          "X",
          "X",
          ["X", "X"],
          null,
          null,
          1,
          1,
          "US:en",
          null,
          1,
          null,
          null,
          null,
          null,
          null,
          0,
          1,
        ],
        "X",
        "X",
        1,
        [1, 1, 1],
        1,
        1,
        null,
        0,
        0,
        null,
        0,
      ],
      base64ArticleId,
      timestamp,
      signature,
    ]);
    const envelope = JSON.stringify([[["Fbv4je", innerJson, null, "generic"]]]);
    const body = new URLSearchParams({ "f.req": envelope }).toString();

    const beRes = await fetchWithTimeout(
      "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": BROWSER_UA,
        },
        body,
      }
    );
    if (!beRes.ok) return url;
    const text = await beRes.text();

    // 응답: ")]}'" 프리픽스 + (길이, JSON 라인) 반복. Fbv4je 항목을 찾아 inner JSON을 다시 파싱.
    for (const line of text.split("\n")) {
      if (!line.includes("Fbv4je")) continue;
      try {
        const arr = JSON.parse(line);
        for (const entry of arr) {
          if (
            Array.isArray(entry) &&
            entry[0] === "wrb.fr" &&
            entry[1] === "Fbv4je" &&
            typeof entry[2] === "string"
          ) {
            const inner = JSON.parse(entry[2]);
            if (
              Array.isArray(inner) &&
              inner[0] === "garturlres" &&
              typeof inner[1] === "string" &&
              /^https?:\/\//.test(inner[1])
            ) {
              return inner[1];
            }
          }
        }
      } catch {
        // 다음 라인 시도
      }
    }
    return url;
  } catch {
    return url;
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

// ===== 링크 생존 확인 =====
// 디코딩된 발행처 URL이 실제로 열리는지 확인해, "안 열리는" 기사는 파이프라인에서 제외.
// 오탐(봇 차단 403·일시 오류 429/5xx·타임아웃)으로 멀쩡한 기사를 지우지 않도록,
// 확실한 사망 신호(404/410/DNS 실패/기사 식별자 유실 리다이렉트)에만 "dead"를 반환한다.
const DEAD_LINK_CHECK_CAP_PER_RUN = 60; // 기존 항목 재검증 1회 상한
const LINK_RECHECK_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 재검증 주기 3일

// 기사 URL의 고유 식별자(순번/idxno/ar-XXXX 등)를 뽑아 soft-404 판정에 사용
function extractIdToken(url) {
  try {
    let m = url.match(/idxno=(\d{3,})/i);
    if (m) return m[1];
    m = url.match(/\/((?:ar|gm|bb)-[A-Za-z0-9]{6,})/i);
    if (m) return m[1];
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i--) {
      if (/^\d{3,}$/.test(segs[i]) || /\d{5,}/.test(segs[i])) return segs[i];
    }
  } catch {
    /* noop */
  }
  return null;
}

// 반환: "alive" | "dead" | "unknown"
async function checkLinkAlive(url) {
  if (!url || !/^https?:\/\//i.test(url)) return "unknown";
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": BROWSER_UA }, redirect: "follow" },
      10000
    );
    const finalUrl = res.url || url;
    if (res.status === 404 || res.status === 410) return "dead";
    if (res.status >= 200 && res.status < 300) {
      // soft-404: 리다이렉트로 기사 식별자를 잃었으면 유실로 간주(비즈워치 include 등)
      const token = extractIdToken(url);
      if (token && !finalUrl.includes(token)) return "dead";
      try {
        const fu = new URL(finalUrl);
        const orig = new URL(url);
        if (
          (fu.pathname === "/" || fu.pathname === "") &&
          orig.pathname.length > 1
        )
          return "dead"; // 루트/홈으로 튕겨나감
      } catch {
        /* noop */
      }
      return "alive";
    }
    // 401/403/429/5xx/미해결 3xx → 봇 차단·일시 오류 가능 → 삭제하지 않음
    return "unknown";
  } catch (err) {
    if (err.name === "AbortError") return "unknown"; // 타임아웃 = 일시적
    const code = err.cause?.code || err.code || "";
    if (/ENOTFOUND|ECONNREFUSED/.test(code)) return "dead"; // 도메인·서버 소멸
    return "unknown";
  }
}

// 신규 RSS 항목 중 "안 열리는" 기사를 분류 전에 제외(AI 토큰도 절약)
async function dropDeadFreshLinks(items) {
  if (items.length === 0) return items;
  const now = new Date().toISOString();
  const verdicts = await mapWithConcurrency(items, 4, async (it) => {
    const v = await checkLinkAlive(it.link);
    it.linkCheckedAt = now;
    return v;
  });
  const kept = [];
  let dropped = 0;
  items.forEach((it, i) => {
    if (verdicts[i] === "dead") {
      dropped++;
      log(`  ✗ 죽은 링크 제외(신규): ${it.headline.slice(0, 40)} | ${it.link}`);
    } else {
      kept.push(it);
    }
  });
  if (dropped > 0) log(`신규 죽은 링크 ${dropped}건 제외`);
  return kept;
}

// 기존 news.json 항목을 순환 재검증하여 "안 열리는" 기사를 제거(1회 상한 적용).
// linkCheckedAt로 오래 안 본 것부터 돌아가며 검증 → 시간이 지나면 코퍼스 전체가 자동 재검증됨.
async function pruneDeadExistingLinks(items) {
  const now = Date.now();
  const due = items.filter((it) => {
    const t = it.linkCheckedAt ? new Date(it.linkCheckedAt).getTime() : 0;
    return now - t >= LINK_RECHECK_INTERVAL_MS;
  });
  if (due.length === 0) return { removedIds: new Set(), checked: 0 };
  due.sort((a, b) => {
    const ta = a.linkCheckedAt ? new Date(a.linkCheckedAt).getTime() : 0;
    const tb = b.linkCheckedAt ? new Date(b.linkCheckedAt).getTime() : 0;
    return ta - tb;
  });
  const slice = due.slice(0, DEAD_LINK_CHECK_CAP_PER_RUN);
  log(`기존 링크 재검증 대상 ${due.length}건 (이번 회 ${slice.length}건 처리)`);
  const nowIso = new Date().toISOString();
  const removedIds = new Set();
  await mapWithConcurrency(slice, 3, async (it) => {
    const v = await checkLinkAlive(it.url);
    it.linkCheckedAt = nowIso;
    if (v === "dead") {
      removedIds.add(it.id);
      log(
        `  ✗ 죽은 링크 제외(기존): ${(it.headline || "").slice(0, 40)} | ${it.url}`
      );
    }
  });
  if (removedIds.size > 0) log(`기존 죽은 링크 ${removedIds.size}건 제외`);
  return { removedIds, checked: slice.length };
}

// ===== 기사 대표 이미지 수집 =====
// 실기사 URL에서 대표 이미지(og:image/twitter:image/JSON-LD/본문 이미지)를 추출.
// LLM 호출 아님 — HTML fetch + 정규식. 실패/부재 時 null(클라이언트가 색 플레이스홀더로 폴백).
function decodeHtmlAttr(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absolutizeImageUrl(raw, pageUrl) {
  if (!raw) return null;
  let value = decodeHtmlAttr(raw).trim();
  if (!value || /^data:/i.test(value) || /^blob:/i.test(value)) return null;

  // srcset 후보는 보통 마지막이 가장 큰 이미지다.
  if (value.includes(",") && /\s+\d+[wx](?:,|$)/.test(value)) {
    const parts = value
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0])
      .filter(Boolean);
    value = parts[parts.length - 1] || value;
  } else {
    value = value.split(/\s+/)[0];
  }

  try {
    const url = new URL(value, pageUrl).href;
    return /^https:\/\//i.test(url) ? url : null; // 브라우저 mixed-content 방지 — https만
  } catch {
    return null;
  }
}

function pickMetaImage(html) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url|:url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']image_src["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function collectJsonLdImages(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => collectJsonLdImages(v, out));
    return out;
  }
  if (typeof value !== "object") return out;

  if (value.image) collectJsonLdImages(value.image, out);
  if (value.thumbnailUrl) collectJsonLdImages(value.thumbnailUrl, out);
  if (value.url && /ImageObject$/i.test(String(value["@type"] || ""))) {
    collectJsonLdImages(value.url, out);
  }
  if (value["@graph"]) collectJsonLdImages(value["@graph"], out);
  return out;
}

function pickJsonLdImage(html) {
  const scripts = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const m of scripts) {
    try {
      const jsonText = decodeHtmlAttr(m[1]).trim();
      if (!jsonText) continue;
      const images = collectJsonLdImages(JSON.parse(jsonText));
      if (images.length) return images[0];
    } catch {
      // 다음 JSON-LD 블록 시도
    }
  }
  return null;
}

function pickBodyImage(html) {
  const candidates = [];
  const imgTags = html.matchAll(/<img\b[^>]*>/gi);
  for (const m of imgTags) {
    const tag = m[0];
    const attr = (name) => {
      const r = new RegExp(`${name}=["']([^"']+)["']`, "i");
      return tag.match(r)?.[1] || "";
    };
    const raw =
      attr("data-src") ||
      attr("data-original") ||
      attr("data-lazy-src") ||
      attr("data-url") ||
      attr("srcset") ||
      attr("data-srcset") ||
      attr("src");
    if (!raw) continue;

    const lowered = raw.toLowerCase();
    if (
      lowered.includes("logo") ||
      lowered.includes("icon") ||
      lowered.includes("sprite") ||
      lowered.includes("blank") ||
      lowered.includes("pixel")
    ) {
      continue;
    }
    candidates.push(raw);
  }
  return candidates[0] || null;
}

function extractRepresentativeImage(html, pageUrl) {
  const raw =
    pickMetaImage(html) ||
    pickJsonLdImage(html) ||
    pickBodyImage(html);
  return absolutizeImageUrl(raw, pageUrl);
}

async function fetchOgImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": BROWSER_UA }, redirect: "follow" },
      8000
    );
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") || "").includes("text/html")) return null;
    const html = (await res.text()).slice(0, 300000);
    return extractRepresentativeImage(html, res.url || url);
  } catch {
    return null;
  }
}
// 분류된 신규 항목들에 image 필드를 채운다(동시성 제한). 항상 image 키를 남겨 스키마 일관.
async function enrichImages(items) {
  if (!items.length) return items;
  const imgs = await mapWithConcurrency(items, 6, async (it) => {
    const src = it.url || it.source?.url || "";
    return await fetchOgImage(src);
  });
  items.forEach((it, i) => {
    it.image = imgs[i] || null;
  });
  const hit = imgs.filter(Boolean).length;
  log(`대표 이미지 수집: ${hit}/${items.length}건 확보`);
  return items;
}

// 인물 증명사진(기자 얼굴) 썸네일 → 토픽 일러스트로 교체.
// http(s) 이미지·미확인(imageChecked 미설정) 항목만 대상, 회당 limit 건까지 판별(비용 분산).
// 원본은 imageOriginal 에 보존. 판별부는 detect-portrait.mjs (정밀도 우선, 애매하면 미교체).
// 반환값: 이번 회차에 상태가 확정(imageChecked 설정)된 건수 → news.json 기록 트리거용.
async function applyPortraitThumbnails(items, limit) {
  const cfg = CONFIG.portraitDetection || {};
  if (DRY_RUN || !client || cfg.enabled === false) return 0;
  const cands = items.filter(
    (it) =>
      it &&
      typeof it.image === "string" &&
      /^https?:\/\//i.test(it.image) &&
      !it.imageChecked
  );
  const batch = cands.slice(0, Math.max(0, limit || 0));
  let replaced = 0;
  let checked = 0;
  for (const it of batch) {
    const verdict = await isPortraitImage(it.image, client);
    if (verdict === null) continue; // 미확정(차단/오류) → 다음 회차 재시도
    it.imageChecked = true;
    checked++;
    if (verdict === true) {
      it.imageOriginal = it.image;
      it.image = pickTopicImage(it);
      it.thumbFace = true;
      replaced++;
    }
  }
  if (checked > 0) {
    log(`썸네일 인물사진 판별: ${checked}건 검사, ${replaced}건 → 토픽 일러스트 교체`);
  }
  return checked;
}

// ===== Load existing =====
async function loadExisting() {
  try {
    const raw = await readFile(NEWS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    log("news.json 부재, 신규 생성합니다");
    return { updatedAt: null, schemaVersion: "v2", items: [] };
  }
}

// ===== Fetch RSS =====
async function fetchAllRss() {
  const all = [];
  for (const source of CONFIG.rssSources) {
    try {
      log(`RSS 폴링: ${source.name}`);
      const feed = await rssParser.parseURL(source.url);
      const items = feed.items
        .slice(0, CONFIG.limits.maxArticlesPerSource)
        .map((it) => ({
          source: source.name,
          region: source.region,
          headline: (it.title || "").trim(),
          link: it.link,
          publishedAt: it.isoDate || it.pubDate || new Date().toISOString(),
          rawContent: (it.contentSnippet || it.content || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 800),
        }))
        .filter(
          (it) =>
            it.link &&
            it.headline.length >= CONFIG.limits.minHeadlineLength
        );
      all.push(...items);
      log(`  → ${items.length}건 수집`);
    } catch (err) {
      log(`  ! 실패: ${err.message}`);
    }
  }
  return all;
}

function dedupeAndFilter(fresh, existing) {
  const existingHashes = new Set(existing.items.map((i) => urlHash(i.url)));
  const seen = new Set();
  const blocked = [];
  const kept = [];

  for (const it of fresh) {
    const h = urlHash(it.link);
    if (existingHashes.has(h)) continue;
    if (seen.has(h)) continue;
    seen.add(h);

    const blockReason = isBlockedByKeyword(it.headline);
    if (blockReason) {
      blocked.push({ headline: it.headline, reason: blockReason });
      continue;
    }
    kept.push(it);
  }

  if (blocked.length > 0) {
    log(`키워드 사전 필터로 ${blocked.length}건 제외`);
  }
  return kept;
}

// ===== Classify via Claude API =====
const COMPETITOR_LIST = CONFIG.competitors
  .map((name) => {
    const brands = CONFIG.competitorBrands?.[name] || [];
    return brands.length
      ? `   - ${name} (하위 브랜드: ${brands.join(", ")})`
      : `   - ${name}`;
  })
  .join("\n");

// ===== 경쟁사 결정적 백스톱 (LLM 거명 누락 보정) =====
// 프롬프트 규칙(PR #58: lens·competitors 독립 판단)만으로는 Haiku가 확률적으로
// 거명된 회사를 competitors 에서 누락하는 사례가 재발 → 코드가 원문 문자열 매칭으로 강제 병합.
// - competitorAliasExcludes(삼성전기·LG디스플레이 등 계열사)를 먼저 제거해 오탐 방지
// - 영문 패턴은 대소문자 구분 + 단어 경계 매칭 (Carrier/Candy 등 일반명사 오탐 방지)
const ALIAS_EXCLUDES = CONFIG.competitorAliasExcludes || [];
const BACKSTOP_SKIP = new Set(CONFIG.competitorBackstopSkip?.names || []);
const COMPETITOR_PATTERNS = (() => {
  const table = [];
  const seen = new Set();
  const add = (canonical, name) => {
    if (!name || BACKSTOP_SKIP.has(name) || seen.has(`${canonical} ${name}`)) return;
    seen.add(`${canonical} ${name}`);
    table.push({ canonical, name, latin: /^[\x00-\x7F]+$/.test(name) });
  };
  for (const canonical of CONFIG.competitors) {
    add(canonical, canonical);
    for (const b of CONFIG.competitorBrands?.[canonical] || []) add(canonical, b);
  }
  for (const [alias, canonical] of Object.entries(CONFIG.competitorAliases || {})) {
    if (alias.startsWith("_")) continue;
    if (CONFIG.competitors.includes(canonical)) add(canonical, alias);
  }
  return table;
})();

function detectCompetitors(text) {
  if (!text) return [];
  let t = String(text);
  for (const ex of ALIAS_EXCLUDES) {
    t = t.split(ex).join(" ");
  }
  const found = new Set();
  for (const { canonical, name, latin } of COMPETITOR_PATTERNS) {
    if (found.has(canonical)) continue;
    if (latin) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`);
      if (re.test(t)) found.add(canonical);
    } else if (t.includes(name)) {
      found.add(canonical);
    }
  }
  return [...found];
}

// ===== 고유명사(기업명) 오역 결정적 가드 =====
// 영문 원문 번역 시 "Hyundai E&C" → "현대차" 같은 계열사 오인을 프롬프트에만 맡기지 않고 코드로 차단.
// scripts/curation.json 의 orgGuards: [{ term, aliases?, evidence[] }]
//   모델 출력(headline/summary/summaryPoints)에 term(또는 aliases)이 나오면,
//   원문(headline + rawContent)에 evidence 中 최소 1개가 반드시 존재해야 한다.
const ORG_GUARDS = CURATION_CFG.orgGuards || [];

function checkOrgGuards(parsed, item) {
  if (!ORG_GUARDS.length) return [];
  const out = [
    parsed.headline || "",
    parsed.summary || "",
    ...(parsed.summaryPoints || []).map((p) => (p && p.text) || ""),
  ].join("\n");
  const src = `${item.headline || ""}\n${item.rawContent || ""}`.toLowerCase();
  const violations = [];
  for (const g of ORG_GUARDS) {
    const names = [g.term, ...(g.aliases || [])].filter(Boolean);
    if (!names.some((n) => out.includes(n))) continue;
    const ok = (g.evidence || []).some((e) =>
      src.includes(String(e).toLowerCase())
    );
    if (!ok) violations.push(g.term);
  }
  return violations;
}

const CLASSIFY_SYSTEM = `당신은 가전 산업(DA, Digital Appliances) 시장 동향 뉴스 분류 전문가입니다.

【출력 형식 — 절대 규칙】
- 응답은 반드시 순수 JSON 객체 1개만 출력
- 코드펜스, 주석, 추가 설명, 거절 응답, 영문 회피 표현 일체 금지
- 입력이 한국어든 영어든, 출력의 headline·summary는 반드시 한국어
- 정치적·민감 주제라도 분류 작업 자체는 절대 거절 금지
- 가전 산업 무관 時 lens를 "skip" 으로 처리

【고유명사 정확성 — 절대 규칙】
- headline·summary·summaryPoints 에 쓰는 회사·기관·지명·제품명은 ★원문에 실제로 표기된 이름★만 사용한다. 원문에 없는 이름으로 바꾸거나 추정으로 채우지 말 것.
- ★영문 원문 번역 시 특히 주의★: 영문 기업명을 한국어로 옮길 때 앞글자(그룹명)만 보고 유사 계열사로 단정하지 말 것. 약칭(E&C, Motor, C&T, Elec 등)이 계열사를 구분하는 핵심이다.
  - "Hyundai E&C" / "Hyundai Engineering & Construction" / "HDEC" → 현대건설 (★현대차·현대자동차 아님★)
  - "Hyundai Motor" / "Hyundai Motor Company" → 현대차
  - "Hyundai Elevator" → 현대엘리베이터 / "Hyundai Department Store" → 현대백화점
  - "GS E&C" → GS건설 / "DL E&C" → DL이앤씨 / "Daewoo E&C" → 대우건설
  - "Samsung Electronics" → 삼성전자 / "Samsung C&T" → 삼성물산 (★삼성전자 아님★)
  - "LG Electronics" → LG전자 / "LG Energy Solution" → LG에너지솔루션 (★LG전자 아님★)
- 국문 정식 상호가 확실하지 않으면 ★원문 표기를 그대로 둘 것★. 임의의 한글 사명으로 바꾸지 말 것.
- ★파생 서사 금지★: 잘못 짚은 회사명 위에 원문에 없는 사업 논리를 만들어 붙이지 말 것.
  (예: 건설사와의 빌트인 가전 공급 건을 "자동차 구매 고객을 가전 구독 고객으로 연결" 같은 구조로 재해석 → 절대 금지)

【가전 산업 무관 → "skip" 처리】
다음 경우는 lens="skip" 으로 반환 (다른 필드는 빈 값/0으로):
- 정치, 외교, 사설, 칼럼, 논평
  ★ 단, 통상·관세 정책 보도(관세율, 무역협정 개정·재협상, USMCA, 원산지 규정, 수출입 규제, Section 232/301, USTR 조치, 보호무역 기조)는 정치·외교 기사로 간주하지 말고 반드시 lens="정책" 으로 정상 분류할 것. 정상회담·행정부 발표가 형식이어도 내용이 통상 정책이면 skip 금지.
- 가전사 무관 일반 금융 (주가, ETF, 환율, 부동산 시황·투자)
  ★ 단, 경쟁사(가전사)가 주체가 되어 주거·공간 사업(모듈러/프리팹 주택, 스마트홈 패키지 등)에 진출하며 생활가전·냉난방공조를 함께 공급하는 보도는 '부동산' 기사가 아니라 '경쟁사 신사업'이다 → skip 금지(아래 【경쟁사 신사업】 규칙 적용).
- 연예, 스포츠, 사고, 일반 IT(반도체·통신 등)
- TV·디스플레이 중심 기사 (OLED TV, QLED, 스마트TV, 텔레비전 등 TV 제품이 주제인 보도)
- 반도체·전자부품 산업 기사: 파운드리, 칩, HBM, 기판, 웨이퍼, 디스플레이 패널 등이 주제인 보도.
  삼성전자·LG전자가 거명돼도 생활가전(DA) 사업과 직접 관련이 없으면 skip.
  (예: "삼성전자, AI칩 파운드리 협력" → skip / "삼성전기, 글래스 코어 기판 합작" → skip)
- 부품·소재 계열사 주체 기사: 삼성전기, 삼성디스플레이, 삼성SDI, 삼성바이오, SK하이닉스, LG디스플레이, LG이노텍, LG화학 등이 주체인 보도 (가전 완제품 관련이 명확한 경우만 예외)

【시의성 검증 → "skip" 처리】
입력의 [오늘 날짜]·[기사 발행일]을 기준으로, 이미 지난 일을 다루는 낡은 기사는 lens="skip":
- 이미 종료된 '예정·예고' 이벤트 보도 (예: 오늘이 2026-05인데 "Q4 실적 발표 예정" → Q4 발표는 이미 1~2월에 종료)
- 제목은 최신·예정처럼 보이나, 본문이 다루는 사건이 [오늘 날짜] 기준 명백히 지난 경우
- 지난 분기·지난 시즌 내용을 현재 일처럼 보도하는 기사
- 판단이 모호하면 skip 하지 말고 정상 분류하되 factors.timeUrgency 를 1로 부여

【프로모션·광고성 → "skip" 처리】
기사 본질이 판촉·광고이면 lens="skip":
- 세일·할인·딜 행사 보도 (메모리얼데이 세일, 블랙프라이데이 할인, "최대 N% 할인" 등)
- 광고성 기사(애드버토리얼)·협찬·홍보성 보도자료
- 단, 경쟁사 신제품 출시·전략, 시장 수요·점유율 분석, 제품 리뷰·평가는 정상 분류 (판촉 행사 자체가 기사 주제가 아니면 유지)

【경쟁사 신사업·신규 비즈니스 모델 — 중점 센싱】
경쟁사의 수익모델·사업영역 확장 보도는 당사 전략 수립의 핵심 입력이므로 절대 skip 하지 말 것:
- 대상: 구독·렌탈(HaaS), 케어·수리·유지보수 서비스, 스마트홈 플랫폼·생태계, B2B·빌트인 진출, 주거·공간 솔루션(모듈러·프리팹 주택, 공간 패키지), 로보틱스·헬스케어/뷰티 디바이스 等 신규 카테고리 진입, M&A·JV·지분투자, D2C·B2C·유통모델 전환
- ★ 주력제품 판로·번들 판단(중요): 경쟁사의 인접·신규 사업이 당사 주력 제품(생활가전·냉난방공조)의 새로운 판로가 되거나 이를 번들로 함께 공급해 판매를 촉진하는 구조이면, 기사에 특정 가전 제품군(냉장고·세탁기 등)이 명시되지 않아도 DA 사업에 직접 유관하다 → 절대 skip 금지, 정상 분류할 것(lens 는 앵글 우선순위대로, 순수 경쟁 동향이면 "경쟁사").
  예: "경쟁사가 모듈러 주택 B2C 진출, 생활가전·공조를 함께 공급" → 주택 자체가 아니라 '가전 판로 확장·번들 판매'가 핵심 시사점이므로 유관. products 는 비어도 무방하되 tags 에 "신사업","주거·공간" 을 부여.
- 해당 時 tags 에 "신사업" 을 반드시 포함하고, 모델 유형 태그를 함께 부여 (예: 구독, M&A, 플랫폼, 로보틱스, B2B, 주거·공간)
- 사업구조 변화는 일회성 신제품보다 파급이 크므로 salesRelevance·marketSize 를 한 단계 상향 검토 (시장 규모·성장률 수치가 본문에 있으면 marketSize 근거로 활용)

【정상 분류】
★★ lens 와 competitors 는 서로 독립된 필드다 ★★
- lens 는 기사의 ‘주된 앵글(관점)’ 1개를 고르는 필드다.
- competitors 는 본문·헤드라인에 ‘실제로 거명된 회사’를 추출하는 필드다.
- 따라서 lens 가 "정책"·"기술"·"소비자"·"거시" 여도, 그 기사에 경쟁사 회사명이 거명됐다면 competitors 에 반드시 넣어야 한다. (lens 가 "경쟁사"일 때만 competitors 를 채우는 것이 아니다)
- 특히 헤드라인의 주어(주체)가 경쟁사면 lens 와 무관하게 competitors 에 그 회사를 반드시 포함한다.
  예: "LG전자, 온실가스 목표 조기 달성" → lens="정책", competitors=["LG전자"]
  예: "LG전자, TSMC 공정 기반 디자인 서비스" → lens="기술", competitors=["LG전자"]

1. lens: 렌즈 카테고리, 다음 中 1개 (기사의 주된 앵글 1개)
   - "소비자": 가전 수요/트렌드/소비 패턴/가격/채택률
   - "기술": 신기술/R&D/부품/소재/AI·IoT 기능
   - "경쟁사": 특정 경쟁사의 전략·신제품·실적 등 ‘경쟁 동향 자체’가 기사의 핵심 주제인 경우
   - "정책": 에너지·환경 규제/관세·통상(무역협정, USMCA, 원산지 규정, 수출입 규제, 보호무역)/보조금/표준
   - "거시": 환율/원자재/주택시장 등 가전 산업 영향
   ※ 경쟁사가 거명됐다고 해서 lens 를 무조건 "경쟁사"로 하지 말 것. 기사 핵심이 규제면 "정책", 신기술이면 "기술"이다. (회사명 추출은 competitors 가 담당)
   ★ 렌즈 결정 우선순위 (여러 축에 걸치면 앞 순서를 우선 채택 — 결과를 결정론적으로 만든다):
     정책 > 거시 > 기술 > 소비자 > 경쟁사
     - 즉 두 축 이상에 해당하면 위 순서에서 먼저 오는 축으로 lens 를 확정한다.
     - "경쟁사"는 최하위 잔여(residual) 렌즈다. 규제·거시·기술·소비 어느 축에도 주된 앵글이 걸리지 않는, 순수 경쟁 동향(실적·전략·신제품 그 자체)일 때만 "경쟁사"로 둔다.
     - 예: 경쟁사가 신흥시장 '수요·가격'을 겨냥한 신제품 → 소비자(소비자>경쟁사). 경쟁사가 규제 목표 달성 → 정책(정책>경쟁사). 경쟁사가 신소재·AI 기능 → 기술(기술>경쟁사).
     - competitors 필드는 이 우선순위와 무관하게, 거명된 회사를 항상 그대로 채운다.

2. products: 관련 제품 (배열, 0개 이상)
   "냉장고", "세탁기", "건조기", "조리기기", "HVAC", "청소기", "식기세척기" 中 해당하는 모두

3. competitors: 거명된 경쟁사 (배열, 0개 이상) — lens 와 독립적으로 판단
   아래 목록 中 헤드라인 또는 본문에 회사명(또는 하위 브랜드)이 ★실제 문자열로 직접 거명된★ 회사를 ★빠짐없이 모두★ 선택.
   ★ 자회사·하위 브랜드가 거명되면 반드시 모기업 경쟁사명으로 분류
     (예: "GE Appliances"→"Haier", "KitchenAid"→"월풀", "Bosch"·"Siemens"→"BSH")
   【반드시 넣는다 — 거명되면 lens 무관하게 포함】
   - 헤드라인/본문에 목록의 회사명이 실제로 나오면, 기사 주제가 규제·기술·소비·거시 무엇이든 그 회사를 competitors 에 넣는다.
   - "삼성·LG", "삼성과 LG전자" 처럼 여러 회사가 함께 거명되면 거명된 회사를 모두 넣는다.
   【과다 부착 금지 — 추론으로 채우지 말 것】
   - "각 제조사", "업계 전반", "가전업계", "글로벌 가전사", "주요 제조사들" 같은 ★포괄·일반 표현★만 있고 특정 회사명이 거명되지 않으면 그 회사를 넣지 말 것
   - 산업 일반론·기술 트렌드 기사에서 "관련 있을 법한" 주요 경쟁사를 임의로 추가하지 말 것 (거명되지 않으면 competitors=[] 가능)
   - 요약하면: ‘거명됐으면 반드시 넣고, 거명 안 됐으면 넣지 않는다’. 판단 기준은 오직 회사명이 실제로 나왔는지 여부이며, lens 값이 아니다.
${COMPETITOR_LIST}

4. factors: 영향도 4 인자 (각 1~5 정수)
   - salesRelevance: 당사 매출 비중 영향도 (해당 제품·지역의 매출 비중)
     ★ 통상·관세 정책 특칙: 당사는 멕시코 등 역외 생산 → 미국 수출 비중이 높아, 북미향 관세·무역협정(USMCA 등)·원산지 규정 변화는 삼성/LG가 거명되지 않아도 salesRelevance 4~5 부여. 협정 폐기·재협상·관세 부과 확정 등 구조 변화는 timeUrgency도 상향.
   - timeUrgency: 시간 긴급성 (24h內=5, 분기內=3, 1년內=2, 그 외=1)
   - marketSize: 시장 규모·CAGR (글로벌 영향=5, 지역 한정=3, 국지=2)
   - sourceReliability: 출처 신뢰도 (1차보도·공시=5, 분석=4, 종합=3, 게시판=1)

5. headline: Herald 압축형 한국어 (30자 이내)
   - 첫머리 연결어 (우선/그 결과/한편/이에 따라/종합하면)
   - 결론 + 수치 권장

6. summary: 3줄 이내 한국어
   - 정량 수치 1개 이상
   - 모호 표현 금지
   - 실적(어닝)·재무 기사: 원문에 보도된 범위 內에서 매출·이익·증감률 등 핵심 수치를 그대로 포함

7. tags: 자유 태그 (배열, 2~5개 권장, 해시 기호 없이)
   - 핵심 키워드, 제품·경쟁사 외 부가 정보

8. summaryPoints: 기사 원문 내용을 2~3개의 짧은 포인트로 정리한 배열
   각 원소는 {"type": "content", "text": "..."}
   - 원문에 보도된 사실만 정리할 것 — 의미 해석, 당사 기회·위협 분석 절대 금지
     (기회·위협 해석은 MI가 아니라 뉴스레터의 역할)
   - ★원문 충실 원칙★: 원문의 구체 수치·고유명사를 그대로 옮길 것.
     뭉뚱그린 추상 표현 금지 (예: "실적 개선 신호", "연간 수준에 도달" → 금지. 수치로 쓸 것)
   - ★실적(어닝) 기사 표준 항목★ — 아래 우선순위대로 포인트에 압축.
     원문(헤드라인·발췌)에 보도된 항목만 담고, 없는 항목은 만들지 말고 건너뛸 것:
     ① 기간 + 매출·이익 수치와 전년 동기 대비 증감률
        (예: "2분기 매출 23조8297억·영업익 1조5788억, 전년比 14.9%·146.9%↑")
     ② 기록·이정표 / 전분기·컨센서스 대비 (예: "상반기 영업익 3조2525억, 작년 연간 초과")
     ③ 실적 요인·부문별 기여 — 원문이 밝힌 사실만 (예: "가전 구독·webOS 확대, 美 관세 환급 약 3000억 반영")
     ④ 회사가 공식 제시한 가이던스·전망
   - ★거시(매크로) 지표 기사 표준 항목★ — lens="거시" 기사에 한해 적용. 원문에 보도된 항목만 담고, 없으면 만들지 말고 건너뛸 것.
     지표의 수치·전월/전년/전주 방향만 사실 그대로 옮기고, 당사 유불리·원가 유리/불리 같은 해석은 절대 금지(해석은 뉴스레터 역할):
     ① 물가·인플레: CPI/PCE/생산자·수입물가 상승률 + 전월·전년비 (예: "6월 미국 CPI 2.4%, 전월비 상승폭 둔화")
     ② 금리·모기지: 기준·국채·모기지 금리 수준 + bp 변화
     ③ 원가 원자재: 유가(WTI)·구리·철강·철광석·레진 등 가격 + 방향 (예: "WTI 배럴당 78달러, 이란 변수로 반등")
     ④ 환율: 원/달러 및 생산거점 통화(페소·바트·동·루피·즈워티) 수준 + 방향
     ⑤ 수요 선행: 주택착공·거래·소비자심리(CCSI 등)·해상운임(SCFI) 수치 + 방향
   - ★정책·규제 기사 표준 항목★ — lens="정책" 기사에 한해 적용. 원문에 보도된 항목만 담고, 없으면 만들지 말 것.
     규제의 도입·강화뿐 아니라 ★연기·완화·재조정·철회의 '사유'★를 사실 그대로 옮긴다(당사 유불리 해석 금지 — 해석은 뉴스레터 역할):
     ① 규제 조치·대상·발효/시행 시점(과 그 변경) (예: "가스온수기 판매금지 시행 '27.1→'28.1 1년 유예")
     ② 연기·완화·재조정 사유 — 비용 부담·형평성·업계/주민 반발 등 원문의 구체 수치 그대로 (예: "전기 전환 설치비 약 $3,500로 가스 대비 $600~1,600 高 → 비용 부담")
     ③ 예외·유예·보조 대상 범위 (예: "저소득 약 18%·전기용량 부족 약 20% 가구 예외 검토")
     ④ 향후 절차·확정 일정 (예: "11월 이사회 표결 예정")
   - type 은 항상 "content" 고정
   - text 는 원문 사실 기반 20~35자 內外 간결체, 기호·번호 없이 본문만

【출력 스키마】
{
  "lens": "...",
  "products": ["..."],
  "competitors": ["..."],
  "factors": {
    "salesRelevance": 1-5,
    "timeUrgency": 1-5,
    "marketSize": 1-5,
    "sourceReliability": 1-5
  },
  "headline": "...",
  "summary": "...",
  "tags": ["..."],
  "summaryPoints": [{"type": "content", "text": "..."}]
}

JSON 외 어떤 텍스트도 출력 금지.`;

async function classifyOne(item, retry = false, hint = "") {
  if (DRY_RUN) {
    return {
      lens: "기술",
      products: ["냉장고"],
      competitors: [],
      factors: {
        salesRelevance: 3,
        timeUrgency: 3,
        marketSize: 3,
        sourceReliability: 3,
      },
      headline: item.headline.slice(0, 30),
      summary: `DRY_RUN 더미 요약: ${item.headline}`,
      tags: ["test"],
      summaryPoints: [{ type: "content", text: `DRY_RUN 포인트: ${item.headline.slice(0, 20)}` }],
    };
  }

  const userPrompt = `${hint ? hint + "\n\n" : ""}[오늘 날짜]
${RUN_DATE}

[기사 발행일]
${item.publishedAt}

[원문 헤드라인]
${item.headline}

[원문 발췌]
${item.rawContent}

[출처]
${item.source}

[지역]
${item.region}`;

  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    system: [
      {
        type: "text",
        text: CLASSIFY_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    if (!retry) {
      log(`  JSON 파싱 실패, 재시도: ${e.message}`);
      await new Promise((r) => setTimeout(r, 800));
      return classifyOne(item, true);
    }
    throw new Error(`JSON 파싱 실패: ${e.message}`);
  }

  if (parsed.lens === "skip") return parsed;

  if (!CONFIG.lenses.includes(parsed.lens)) {
    throw new Error(`lens 검증 실패: ${parsed.lens}`);
  }
  if (!parsed.factors) {
    throw new Error("factors 누락");
  }

  // Sanitize arrays
  parsed.products = (parsed.products || []).filter((p) =>
    CONFIG.products.includes(p)
  );
  parsed.competitors = (parsed.competitors || []).filter((c) =>
    CONFIG.competitors.includes(c)
  );
  // 결정적 백스톱: 원문(헤드라인·발췌)에 실제 거명된 경쟁사를 LLM이 누락했으면 병합
  const detected = detectCompetitors(
    `${item.headline || ""}\n${item.rawContent || ""}`
  );
  if (detected.length) {
    parsed.competitors = [...new Set([...parsed.competitors, ...detected])];
  }
  parsed.tags = (parsed.tags || []).slice(0, 5);

  // 역할분담: MI는 기사 원문 사실 정리만(점 2~3개) — 기회/위협 해석은 뉴스레터 담당
  parsed.summaryPoints = Array.isArray(parsed.summaryPoints)
    ? parsed.summaryPoints
        .filter((p) => p && typeof p.text === "string" && p.text.trim())
        .slice(0, 3)
        .map((p) => ({
          type: "content",
          text: p.text.trim().slice(0, 120),
        }))
    : [];

  // 기업명 오역 가드: 위반 時 1회 재시도, 그래도 위반이면 저장하지 않고 폐기
  const orgViolations = checkOrgGuards(parsed, item);
  if (orgViolations.length) {
    const names = orgViolations.join(", ");
    if (!retry) {
      log(`  기업명 오역 의심(${names}) → 재시도`);
      await new Promise((r) => setTimeout(r, 800));
      return classifyOne(
        item,
        true,
        `[경고] 직전 시도에서 원문에 근거가 없는 기업명(${names})이 사용됐습니다. 원문에 실제로 표기된 회사명만 쓰고, 영문 약칭(E&C, Motor, C&T, Elec 등)을 임의로 다른 계열사로 바꾸지 마십시오.`
      );
    }
    throw new Error(`기업명 오역 가드 위반(${names}) — 저장 제외`);
  }

  // Clamp factors
  for (const k of [
    "salesRelevance",
    "timeUrgency",
    "marketSize",
    "sourceReliability",
  ]) {
    parsed.factors[k] = Math.max(
      1,
      Math.min(5, Math.round(parsed.factors[k] || 3))
    );
  }

  return parsed;
}

async function classifyAll(items, startId) {
  const toProcess = items.slice(0, CONFIG.limits.maxArticlesPerRun);
  const classified = [];
  let nextId = startId;
  let skipCount = 0;
  let failCount = 0;

  for (const item of toProcess) {
    try {
      log(`분류 中: ${item.headline.slice(0, 40)}...`);
      const cls = await classifyOne(item);

      if (cls.lens === "skip") {
        skipCount++;
        log(`  → skip`);
      } else {
        const impact = computeImpact(cls.factors);
        const grade = gradeFromImpact(impact);
        classified.push({
          id: nextId++,
          lens: cls.lens,
          grade: grade,
          impact: impact,
          factors: cls.factors,
          products: cls.products,
          competitors: cls.competitors,
          tags: cls.tags,
          headline: cls.headline,
          summary: cls.summary,
          summaryPoints: cls.summaryPoints,
          source: {
            name: item.source,
            url: item.link,
          },
          publishedAt: item.publishedAt,
          url: item.link,
          linkCheckedAt: item.linkCheckedAt,
        });
        log(`  → ${cls.lens} / ${grade} (impact ${impact})`);
      }
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      failCount++;
      log(`  ! 분류 실패: ${err.message}`);
    }
  }
  log(
    `분류 결과: 정상 ${classified.length}건, skip ${skipCount}건, 실패 ${failCount}건`
  );
  return classified;
}

function prune(items) {
  const before = items.length;
  const kept = items.filter((i) => isWithinRetention(i.publishedAt, i.grade));
  log(`보존 기간 적용: ${before}건 → ${kept.length}건`);
  return kept;
}

// 제목·내용이 유사한 같은 사건 기사를 1건으로 묶음 (영향도 높은 기사 유지)
function dedupeMerged(items) {
  const TH = CONFIG.dedupe?.similarityThreshold ?? 0.16;
  const WIN_MS = (CONFIG.dedupe?.timeWindowHours ?? 72) * 3600e3;
  const sig = items.map((it) => ({
    hb: bigramSet(canonForSim(it.headline)),
    sb: bigramSet(canonForSim(it.summary)),
    pb: bigramSet(canonForSim(pointsText(it))),
    t: new Date(it.publishedAt).getTime(),
  }));
  const textSim = (i, j) =>
    0.45 * jaccard(sig[i].hb, sig[j].hb) +
    0.30 * jaccard(sig[i].sb, sig[j].sb) +
    0.25 * jaccard(sig[i].pb, sig[j].pb);

  // union-find: 같은 경쟁사·제품을 공유하고 텍스트가 유사하면 동일 사건으로 묶음
  const parent = items.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      // 같은 사건은 좁은 시간창에 몰려 터진다. 시간창 게이트가 없으면 낮은 임계값에서
      // 서로 다른 사건이 union-find 전이로 대형 오병합 덩어리를 만든다(검증 완료).
      const sameWindow = Math.abs(sig[i].t - sig[j].t) <= WIN_MS;
      if (sameWindow && sharesEntity(items[i], items[j]) && textSim(i, j) >= TH) {
        parent[find(i)] = find(j);
      }
    }
  }

  const clusters = new Map();
  items.forEach((it, i) => {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(it);
  });

  const kept = [];
  let foldedGroups = 0;
  let foldedTotal = 0;
  for (const group of clusters.values()) {
    group.sort(
      (a, b) =>
        (b.impact || 0) - (a.impact || 0) ||
        new Date(b.publishedAt) - new Date(a.publishedAt)
    );
    const rep = group[0];

    // 대표 기사에 나머지 멤버 + 각 멤버가 이전 회차에 이미 보유한 관련기사를 병합해 보존.
    // (losers 는 top-level 에서 사라지므로 다음 회차 재수집 없이도 관련기사 목록이 유지된다.
    //  대표가 뒤바뀌어도 이전 대표·관련기사를 그대로 승계.)
    const seen = new Set([relatedKey(rep)]);
    const related = [];
    const addRel = (r) => {
      const k = relatedKey(r);
      if (!k || seen.has(k)) return;
      seen.add(k);
      related.push(toRelated(r));
    };
    for (const m of group) {
      for (const prev of m.relatedArticles || []) addRel(prev);
      if (m !== rep) addRel(m);
    }

    if (related.length) {
      rep.relatedArticles = related.slice(0, 20);
      foldedGroups += 1;
      foldedTotal += related.length;
    } else if (rep.relatedArticles) {
      delete rep.relatedArticles;
    }
    kept.push(rep);
  }
  if (foldedTotal > 0) {
    log(
      `같은 사건 묶음: 대표 ${foldedGroups}건에 관련기사 ${foldedTotal}건 접힘 ` +
        `(${items.length}건 → 노출 ${kept.length}건)`
    );
  }
  return kept;
}

// ===== 수동 큐레이션 (오분류·중복 카드 즉시 제거/정정) =====
// scripts/curation.json 의 curation:
//   denyIds  : 화면에서 완전히 제거할 기사 id 배열
//   denyUrls : 제거할 기사 URL 배열 (재수집 시에도 계속 차단)
//   overrides: { "<id>": { headline, summary, summaryPoints, ... } } 필드 덮어쓰기
function applyCuration(items) {
  const cur = CURATION_CFG.curation || {};
  const denyIds = new Set((cur.denyIds || []).map(Number));
  const denyUrls = new Set(
    (cur.denyUrls || []).map((u) => String(u).trim()).filter(Boolean)
  );
  const overrides = cur.overrides || {};

  let denied = 0;
  const kept = items.filter((it) => {
    if (denyIds.has(Number(it.id)) || denyUrls.has(String(it.url || "").trim())) {
      denied++;
      return false;
    }
    return true;
  });

  let fixed = 0;
  for (const it of kept) {
    const ov = overrides[String(it.id)];
    if (!ov || typeof ov !== "object") continue;
    Object.assign(it, ov);
    it.curated = true;
    fixed++;
  }

  if (denied > 0 || fixed > 0) {
    log(`수동 큐레이션 적용: 제거 ${denied}건, 정정 ${fixed}건`);
  }
  return { items: kept, denied, fixed };
}

// 기존 news.json 항목의 Google News URL을 실제 URL로 일괄 변환 (한 회 실행당 상한 적용)
const URL_BACKFILL_LIMIT_PER_RUN = 80;

async function backfillExistingUrls(items) {
  const targets = items.filter((it) => isGoogleNewsUrl(it.url));
  if (targets.length === 0) return 0;
  const slice = targets.slice(0, URL_BACKFILL_LIMIT_PER_RUN);
  log(`기존 URL 백필 대상 ${targets.length}건 (이번 회 ${slice.length}건 처리)`);

  let converted = 0;
  await mapWithConcurrency(slice, 3, async (it) => {
    const resolved = await decodeGoogleNewsUrl(it.url);
    if (resolved && resolved !== it.url) {
      it.url = resolved;
      if (it.source) it.source.url = resolved;
      converted++;
    }
  });
  return converted;
}

async function resolveFreshLinks(items) {
  const targets = items.filter((it) => isGoogleNewsUrl(it.link));
  if (targets.length === 0) return;
  log(`신규 RSS 링크 ${targets.length}건 실제 URL 해석 시도`);
  await mapWithConcurrency(targets, 3, async (it) => {
    const resolved = await decodeGoogleNewsUrl(it.link);
    if (resolved && resolved !== it.link) it.link = resolved;
  });
}

// ===== Main =====
async function main() {
  log("=== DA Market Insight v2 뉴스 갱신 시작 ===");

  const existing = await loadExisting();
  log(`기존 뉴스 ${existing.items.length}건 로드`);

  // schema migration check - v1 data가 있으면 무시하고 새로 시작
  const isV1 = existing.items.some((i) => i.signal || i.category);
  if (isV1) {
    log(`v1 스키마 감지 → 빈 상태로 재시작 (다음 분류부터 v2 적용)`);
    existing.items = [];
  }

  // blockKeywords 소급 적용: 이미 적재된 기사도 매 실행 시 제거 (키워드 추가分 반영)
  const beforePurge = existing.items.length;
  existing.items = existing.items.filter(
    (i) => !isBlockedByKeyword(i.headline || "")
  );
  const purged = beforePurge - existing.items.length;
  if (purged > 0) {
    log(`차단 키워드 소급 적용: 기존 ${purged}건 제거`);
  }

  // 경쟁사 백스톱 소급 적용: 기존 적재분도 headline·summary 거명 기준으로 매 실행 시 보정
  let compFixed = 0;
  for (const i of existing.items) {
    const detected = detectCompetitors(`${i.headline || ""}\n${i.summary || ""}`);
    if (!detected.length) continue;
    const mergedComps = [...new Set([...(i.competitors || []), ...detected])];
    if (mergedComps.length !== (i.competitors || []).length) {
      i.competitors = mergedComps;
      compFixed++;
    }
  }
  if (compFixed > 0) {
    log(`경쟁사 백스톱 소급 적용: ${compFixed}건 보정`);
  }

  // 요약 포인트 역할분담 소급 적용: 기존 opportunity/threat 타입을 content 로 정규화
  // (MI = 원문 사실 정리 전용, 기회/위협 해석은 뉴스레터 담당)
  let ptFixed = 0;
  for (const i of existing.items) {
    if (!Array.isArray(i.summaryPoints)) continue;
    for (const p of i.summaryPoints) {
      if (p && p.type !== "content") {
        p.type = "content";
        ptFixed++;
      }
    }
  }
  if (ptFixed > 0) {
    log(`요약 포인트 타입 소급 정규화: ${ptFixed}건 → content`);
  }

  const backfilled = await backfillExistingUrls(existing.items);
  if (backfilled > 0) {
    log(`기존 Google News URL ${backfilled}건 → 실제 발행처 URL로 변환`);
  }

  // 기존 항목 링크 생존 재검증(회당 상한) → 죽은 링크 id 집합을 prune 단계에서 제외
  const { removedIds: deadIds } = await pruneDeadExistingLinks(existing.items);

  const fresh = await fetchAllRss();
  log(`RSS 폴링 총 ${fresh.length}건 수집`);

  await resolveFreshLinks(fresh);

  const deduped = dedupeAndFilter(fresh, existing);
  const newOnes = await dropDeadFreshLinks(deduped);
  log(`중복·필터·링크확인 後 분류 대상 ${newOnes.length}건`);

  const startId = Math.max(0, ...existing.items.map((i) => i.id || 0)) + 1;
  const classified = newOnes.length
    ? await classifyAll(newOnes, startId)
    : [];
  if (newOnes.length === 0) log("신규 분류 대상 없음");
  else log(`AI 분류 완료: ${classified.length}건 저장 대상`);

  await enrichImages(classified); // 신규 분류분에 og:image 부착(토큰 비용 0)

  // 인물 증명사진 썸네일 → 토픽 일러스트 교체 (신규분 전량 + 기존분 회전 배치)
  const faceNew = await applyPortraitThumbnails(classified, classified.length);
  const backlogN = CONFIG.portraitDetection?.backlogPerRun ?? 12;
  const faceChecked = faceNew + (await applyPortraitThumbnails(existing.items, backlogN));

  // 보존 기간 정리 → 같은 사건 기사 묶음 → 최신순 정렬
  const pruned = prune(
    [...classified, ...existing.items].filter((it) => !deadIds.has(it.id))
  );
  const merged = dedupeMerged(pruned).sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );

  // 수동 큐레이션(제거·정정)은 항상 마지막에 적용해 매 실행마다 재적용된다
  const curation = applyCuration(merged);
  const finalItems = curation.items;

  const changed =
    isV1 ||
    purged > 0 ||
    deadIds.size > 0 ||
    compFixed > 0 ||
    ptFixed > 0 ||
    faceChecked > 0 ||
    classified.length > 0 ||
    curation.denied > 0 ||
    curation.fixed > 0 ||
    finalItems.length !== existing.items.length ||
    backfilled > 0;
  if (!changed) {
    log("변경 없음");
    return;
  }

  await writeFile(
    NEWS_PATH,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        schemaVersion: "v2",
        items: finalItems,
      },
      null,
      2
    )
  );
  log(`news.json 갱신 완료, 총 ${finalItems.length}건 보유`);
  log("=== 완료 ===");
}

// 재사용을 위한 export (reclassify.mjs 等에서 분류 로직 재활용)
export { CONFIG, CLASSIFY_SYSTEM, classifyOne, computeImpact, gradeFromImpact };

// 직접 실행(node fetch-news.js)일 때만 전체 파이프라인 구동. import 時엔 실행 안 함.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    log(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
  });
}
