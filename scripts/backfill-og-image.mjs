// 기존 news.json 백필: image 필드가 비어 있는 레코드에 원문 대표 이미지(og:image)를
// 소급 부착한다. 신규 수집분은 fetch-news.js(enrichImages)가 자동으로 채우므로,
// 이 스크립트는 도입 시점 이전 축적분(약 630건)을 1회 정정하는 용도다.
//
// - LLM 호출 아님 — 실기사 HTML fetch + 정규식(og:image/twitter:image/JSON-LD/본문 이미지). 토큰 비용 0.
// - 추출 로직은 scripts/fetch-news.js 의 fetchOgImage 와 동일(https만·8s 타임아웃·mixed-content 방지).
// - 실패/부재 時 image=null 로 남겨 스키마 일관(클라이언트가 lens 색 플레이스홀더로 폴백).
// - 자동 실행 아님. 승인 후 수동 실행:  node scripts/backfill-og-image.mjs [--dry] [--force]
//     --dry   : 파일 미기록, 통계만 출력
//     --force : 이미 image 키가 있어도 재수집(기본은 image 값이 비어 있는 건만)
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEWS_PATH = join(ROOT, "data", "news.json");
const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
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

const data = JSON.parse(await readFile(NEWS_PATH, "utf8"));
const all = data.items || [];

// 대상: skip 제외 + (force면 전부 / 기본은 image 값이 비어 있는 건만)
const targets = all.filter(
  (n) => n.lens !== "skip" && (FORCE || !("image" in n) || !n.image)
);

console.log(
  `대상 ${targets.length} / 전체 ${all.length}건` +
    (FORCE ? " (--force: image 키 유무 무시)" : " (image 값이 비어 있는 건만)")
);
if (!targets.length) {
  console.log("백필할 대상이 없습니다.");
  process.exit(0);
}

let done = 0;
const imgs = await mapWithConcurrency(targets, 6, async (n) => {
  const src = n.url || n.source?.url || "";
  const r = await fetchOgImage(src);
  done++;
  if (done % 50 === 0) console.log(`  ...${done}/${targets.length}`);
  return r;
});

let hit = 0;
targets.forEach((n, i) => {
  n.image = imgs[i] || null; // 항상 image 키를 남긴다(스키마 일관)
  if (imgs[i]) hit++;
});

console.log(`대표 이미지 확보: ${hit}/${targets.length}건 (나머지는 null → 색 플레이스홀더)`);

if (DRY) {
  console.log("\n[--dry] 파일 미기록");
} else {
  await writeFile(NEWS_PATH, JSON.stringify(data, null, 2));
  console.log(`\nnews.json 갱신 완료 (${targets.length}건 image 필드 기록)`);
}


