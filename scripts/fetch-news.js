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
import Parser from "rss-parser";
import { readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CONFIG = JSON.parse(
  await readFile(join(__dirname, "config.json"), "utf-8")
);

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

    const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
    const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);
    if (!sigMatch || !tsMatch) return url;
    const signature = sigMatch[1];
    const timestamp = Number(tsMatch[1]);

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

const CLASSIFY_SYSTEM = `당신은 가전 산업(DA, Digital Appliances) 시장 동향 뉴스 분류 전문가입니다.

【출력 형식 — 절대 규칙】
- 응답은 반드시 순수 JSON 객체 1개만 출력
- 코드펜스, 주석, 추가 설명, 거절 응답, 영문 회피 표현 일체 금지
- 입력이 한국어든 영어든, 출력의 headline·summary는 반드시 한국어
- 정치적·민감 주제라도 분류 작업 자체는 절대 거절 금지
- 가전 산업 무관 時 lens를 "skip" 으로 처리

【가전 산업 무관 → "skip" 처리】
다음 경우는 lens="skip" 으로 반환 (다른 필드는 빈 값/0으로):
- 정치, 외교, 사설, 칼럼, 논평
- 가전사 무관 일반 금융 (주가, ETF, 환율, 부동산)
- 연예, 스포츠, 사고, 일반 IT(반도체·통신 등)
- TV·디스플레이 중심 기사 (OLED TV, QLED, 스마트TV, 텔레비전 등 TV 제품이 주제인 보도)

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

【정상 분류】
1. lens: 시각 카테고리, 다음 中 1개
   - "소비자": 가전 수요/트렌드/소비 패턴/가격/채택률
   - "기술": 신기술/R&D/부품/소재/AI·IoT 기능 (회사 비특정)
   - "경쟁사": ${CONFIG.competitors.length}개 경쟁사의 동향 (회사명 직접 등장)
   - "정책": 에너지·환경 규제/관세/보조금/표준
   - "거시": 환율/원자재/주택시장 등 가전 산업 영향

2. products: 관련 제품 (배열, 0개 이상)
   "냉장고", "세탁기", "건조기", "조리기기", "HVAC", "청소기", "식기세척기" 中 해당하는 모두

3. competitors: 관련 경쟁사 (배열, 0개 이상)
   아래 목록 中 본문에 명시적으로 등장하는 모기업명을 모두 선택.
   ★ 자회사·하위 브랜드가 등장하면 반드시 모기업 경쟁사명으로 분류
     (예: "GE Appliances"→"Haier", "KitchenAid"→"월풀", "Bosch"·"Siemens"→"BSH")
${COMPETITOR_LIST}

4. factors: 영향도 4 인자 (각 1~5 정수)
   - salesRelevance: 당사 매출 비중 영향도 (해당 제품·지역의 매출 비중)
   - timeUrgency: 시간 긴급성 (24h內=5, 분기內=3, 1년內=2, 그 외=1)
   - marketSize: 시장 규모·CAGR (글로벌 영향=5, 지역 한정=3, 국지=2)
   - sourceReliability: 출처 신뢰도 (1차보도·공시=5, 분석=4, 종합=3, 게시판=1)

5. headline: Herald 압축형 한국어 (30자 이내)
   - 첫머리 연결어 (우선/그 결과/한편/이에 따라/종합하면)
   - 결론 + 수치 권장

6. summary: 3줄 이내 한국어
   - 정량 수치 1개 이상
   - 모호 표현 금지

7. tags: 자유 태그 (배열, 2~5개 권장, 해시 기호 없이)
   - 핵심 키워드, 제품·경쟁사 외 부가 정보

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
  "tags": ["..."]
}

JSON 외 어떤 텍스트도 출력 금지.`;

async function classifyOne(item, retry = false) {
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
    };
  }

  const userPrompt = `[오늘 날짜]
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
  parsed.tags = (parsed.tags || []).slice(0, 5);

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
          source: {
            name: item.source,
            url: item.link,
          },
          publishedAt: item.publishedAt,
          url: item.link,
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
  const TH = CONFIG.dedupe?.similarityThreshold ?? 0.22;
  const sig = items.map((it) => ({
    hb: bigramSet(normForSim(it.headline)),
    sb: bigramSet(normForSim(it.summary)),
  }));
  const textSim = (i, j) =>
    0.65 * jaccard(sig[i].hb, sig[j].hb) + 0.35 * jaccard(sig[i].sb, sig[j].sb);

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
      if (sharesEntity(items[i], items[j]) && textSim(i, j) >= TH) {
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
  let removed = 0;
  for (const group of clusters.values()) {
    if (group.length > 1) {
      group.sort(
        (a, b) =>
          (b.impact || 0) - (a.impact || 0) ||
          new Date(b.publishedAt) - new Date(a.publishedAt)
      );
      removed += group.length - 1;
    }
    kept.push(group[0]);
  }
  if (removed > 0) {
    log(`중복 기사 묶음: ${removed}건 제거 (${items.length}건 → ${kept.length}건)`);
  }
  return kept;
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

  const backfilled = await backfillExistingUrls(existing.items);
  if (backfilled > 0) {
    log(`기존 Google News URL ${backfilled}건 → 실제 발행처 URL로 변환`);
  }

  const fresh = await fetchAllRss();
  log(`RSS 폴링 총 ${fresh.length}건 수집`);

  await resolveFreshLinks(fresh);

  const newOnes = dedupeAndFilter(fresh, existing);
  log(`중복·필터 後 분류 대상 ${newOnes.length}건`);

  const startId = Math.max(0, ...existing.items.map((i) => i.id || 0)) + 1;
  const classified = newOnes.length
    ? await classifyAll(newOnes, startId)
    : [];
  if (newOnes.length === 0) log("신규 분류 대상 없음");
  else log(`AI 분류 완료: ${classified.length}건 저장 대상`);

  // 보존 기간 정리 → 같은 사건 기사 묶음 → 최신순 정렬
  const pruned = prune([...classified, ...existing.items]);
  const merged = dedupeMerged(pruned).sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );

  const changed =
    isV1 ||
    classified.length > 0 ||
    merged.length !== existing.items.length ||
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
        items: merged,
      },
      null,
      2
    )
  );
  log(`news.json 갱신 완료, 총 ${merged.length}건 보유`);
  log("=== 완료 ===");
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
