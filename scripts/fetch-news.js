#!/usr/bin/env node
/**
 * DA Market Insight 뉴스 수집·분류 스크립트 (v2)
 *
 * v2 개선 사항:
 *   - 가전 산업 무관 뉴스 자동 제외 (blockKeywords + skip 카테고리)
 *   - 영문 뉴스도 한국어 헤드라인·요약 자동 변환
 *   - JSON 검증 강화 + 1회 재시도
 *   - 거절 응답 차단 강제
 *
 * 환경변수:
 *   ANTHROPIC_API_KEY (필수)
 *   DRY_RUN=1 (선택, API 호출 없이 RSS 수집만 테스트)
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

const client = DRY_RUN
  ? null
  : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const rssParser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "DA-Market-Insight/2.0" },
});

// ===== Utilities =====
function urlHash(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

function isWithinRetention(publishedAt, signal) {
  const days = CONFIG.retention[signal] ?? 30;
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  return ageMs / (1000 * 60 * 60 * 24) <= days;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ===== Pre-filter (block keywords before API call) =====
function isBlockedByKeyword(headline) {
  const lower = headline.toLowerCase();
  for (const kw of CONFIG.filterRules.blockKeywords) {
    if (headline.includes(kw) || lower.includes(kw.toLowerCase())) {
      return kw;
    }
  }
  return null;
}

// ===== 1. Load existing news =====
async function loadExisting() {
  try {
    const raw = await readFile(NEWS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    log("news.json 부재, 신규 생성합니다");
    return { updatedAt: null, items: [] };
  }
}

// ===== 2. Fetch RSS =====
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

// ===== 3. Dedupe + pre-filter =====
function dedupeAndFilter(fresh, existing) {
  const existingHashes = new Set(
    existing.items.map((i) => urlHash(i.url))
  );
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
    log(`키워드 사전 필터로 ${blocked.length}건 제외:`);
    blocked.slice(0, 5).forEach((b) => {
      log(`  - "${b.headline.slice(0, 40)}..." (키워드: ${b.reason})`);
    });
    if (blocked.length > 5) log(`  ... 外 ${blocked.length - 5}건`);
  }
  return kept;
}

// ===== 4. Classify via Claude API =====
const CLASSIFY_SYSTEM = `당신은 가전 산업(DA, Digital Appliances) 시장 동향 뉴스 분류 전문가입니다.

【출력 형식 — 절대 규칙】
- 응답은 반드시 순수 JSON 객체 1개만 출력
- 코드펜스(\`\`\`), 주석, 추가 설명, 거절 문구, "I cannot/should not" 같은 영문 회피 표현 일체 금지
- 입력이 한국어든 영어든 다른 언어든, 출력의 headline·summary는 반드시 한국어
- 정치적·민감 주제라도 분류 작업 자체는 절대 거절 금지
  (가전 산업 무관 시 category를 "skip" 으로 처리하면 됨)

【가전 산업 무관 → category: "skip" 으로 반환】
다음 경우는 분류하지 말고 "skip" 처리:
- 정치, 외교, 사설, 칼럼, 논평
- 일반 금융 뉴스 (주가, 환율, 채권, ETF, 펀드) — 단, 가전사 자체 주가·실적은 OK
- 연예, 스포츠, 사고, 부동산 매매
- 가전과 직접 관련 없는 일반 IT (반도체, 통신, 인터넷 서비스 等)

skip 처리 時 다른 필드는 다음과 같이:
{
  "category": "skip",
  "signal": "New",
  "relatedBu": [],
  "headline": "skip",
  "summary": "skip: 가전 산업 무관"
}

【정상 분류 (가전 산업 관련 뉴스인 경우)】

1. category: "소비자" / "기술" / "경쟁사" / "정책" / "거시" 中 1개
   - 소비자: 가전 수요, 트렌드, 소비 패턴, 가격, 채택률
   - 기술: 신기술, R&D, 부품, 소재, AI·IoT 가전 기능
   - 경쟁사: LG·Whirlpool·Bosch·Haier·Miele·Electrolux·Daikin·Dyson 等의 동향
   - 정책: 에너지 규제, 환경 규제, 통상 정책, 보조금, 표준
   - 거시: 환율(가전 단가 영향), 원자재, 통상, 주택 시장 (가전 수요 영향 명백한 경우만)

2. signal: "New" / "Deep" / "Insight" 中 1개
   - New: 발표·출시·발효 등 신호의 시작점
   - Deep: 구조적 동인·인과 분석, 장기 영향 설명
   - Insight: 함의·승부처, 의사결정에 결정적인 통찰

3. relatedBu: ["냉장고", "세탁기", "에어컨", "주방가전", "소형가전"] 中 관련된 모든 사업부 (배열, 1개 이상)

4. headline: Herald 압축형 한국어 (30자 이내)
   - 첫머리에 연결어 1개 부여 (우선/그 결과/한편/이에 따라/종합하면/가장 먼저/구체적으로)
   - 결론 + 수치 포함 권장
   - 영문 고유명사는 그대로 (LG, Bosch 等)
   - 모호 표현 금지 (필요·검토·강화)

5. summary: 3줄 이내 한국어
   - 첫 줄도 연결어로 시작
   - 정량 수치 1개 이상 포함 (없으면 정성 정보로 대체)
   - 모호 표현 금지

【출력 스키마 (절대 변경 금지)】
{
  "category": "...",
  "signal": "...",
  "relatedBu": ["..."],
  "headline": "...",
  "summary": "..."
}

JSON 외 어떤 텍스트도 출력 금지. 코드펜스 금지. 거절 응답 금지. 영문 회피 표현 금지.`;

async function classifyOne(item, retry = false) {
  if (DRY_RUN) {
    return {
      category: "기술",
      signal: "New",
      relatedBu: ["냉장고"],
      headline: item.headline.slice(0, 30),
      summary: "DRY_RUN 모드 더미 요약입니다. 실제 분류 결과 아닙니다.",
    };
  }

  const userPrompt = `[원문 헤드라인]
${item.headline}

[원문 발췌]
${item.rawContent}

[출처]
${item.source}

[지역]
${item.region}`;

  const res = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: CLASSIFY_SYSTEM,
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
    throw new Error(`JSON 파싱 최종 실패: ${e.message}`);
  }

  if (parsed.category === "skip") {
    return parsed;
  }

  if (
    !CONFIG.categories.includes(parsed.category) ||
    !CONFIG.signals.includes(parsed.signal)
  ) {
    throw new Error(
      `분류 결과 검증 실패: category=${parsed.category}, signal=${parsed.signal}`
    );
  }

  if (!Array.isArray(parsed.relatedBu) || parsed.relatedBu.length === 0) {
    parsed.relatedBu = ["냉장고"];
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
      log(`분류 중: ${item.headline.slice(0, 40)}...`);
      const cls = await classifyOne(item);

      if (cls.category === "skip") {
        skipCount++;
        log(`  → skip (가전 무관)`);
      } else {
        classified.push({
          id: nextId++,
          category: cls.category,
          signal: cls.signal,
          headline: cls.headline,
          summary: cls.summary,
          source: item.source,
          publishedAt: item.publishedAt,
          url: item.link,
          relatedBu: cls.relatedBu,
        });
        log(`  → ${cls.category}/${cls.signal} (${cls.relatedBu.join(",")})`);
      }
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      failCount++;
      log(`  ! 분류 실패, 건너뜀: ${err.message}`);
    }
  }
  log(
    `분류 결과: 정상 ${classified.length}건, skip ${skipCount}건, 실패 ${failCount}건`
  );
  return classified;
}

// ===== 5. Prune old =====
function prune(items) {
  const before = items.length;
  const kept = items.filter((i) =>
    isWithinRetention(i.publishedAt, i.signal)
  );
  log(`보존 기간 적용: ${before}건 → ${kept.length}건`);
  return kept;
}

// ===== Main =====
async function main() {
  log("=== DA Market Insight 뉴스 갱신 시작 (v2) ===");

  const existing = await loadExisting();
  log(`기존 뉴스 ${existing.items.length}건 로드`);

  const fresh = await fetchAllRss();
  log(`RSS 폴링 총 ${fresh.length}건 수집`);

  const newOnes = dedupeAndFilter(fresh, existing);
  log(`중복·필터 後 분류 대상 ${newOnes.length}건`);

  if (newOnes.length === 0) {
    log("신규 분류 대상 없음, 보존 기간 정리만 수행");
    const pruned = prune(existing.items);
    if (pruned.length !== existing.items.length) {
      await writeFile(
        NEWS_PATH,
        JSON.stringify(
          { updatedAt: new Date().toISOString(), items: pruned },
          null,
          2
        )
      );
      log("news.json 갱신 (보존 기간 정리)");
    } else {
      log("변경 사항 없음");
    }
    return;
  }

  const startId = Math.max(0, ...existing.items.map((i) => i.id || 0)) + 1;
  const classified = await classifyAll(newOnes, startId);
  log(`AI 분류 完了: ${classified.length}건 저장 대상`);

  const merged = prune([...classified, ...existing.items]).sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );

  await writeFile(
    NEWS_PATH,
    JSON.stringify(
      { updatedAt: new Date().toISOString(), items: merged },
      null,
      2
    )
  );
  log(`news.json 갱신 完了, 총 ${merged.length}건 보유`);
  log("=== 完了 ===");
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
