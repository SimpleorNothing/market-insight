#!/usr/bin/env node
/**
 * DA Market Insight 뉴스 수집·분류 스크립트
 *
 * 동작 흐름:
 *   1. config.json 의 RSS 소스 폴링
 *   2. 기존 news.json 과 URL 해시 비교, 중복 제거
 *   3. Claude API (Haiku 4.5) 로 카테고리·신호·사업부·요약 동시 분류
 *   4. 보존 기간 경과 뉴스 자동 제거
 *   5. news.json 갱신
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
  headers: { "User-Agent": "DA-Market-Insight/1.0" },
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

// ===== 3. Dedupe vs existing =====
function dedupe(fresh, existing) {
  const existingHashes = new Set(
    existing.items.map((i) => urlHash(i.url))
  );
  const seen = new Set();
  return fresh.filter((it) => {
    const h = urlHash(it.link);
    if (existingHashes.has(h)) return false;
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}

// ===== 4. Classify via Claude API =====
const CLASSIFY_SYSTEM = `당신은 가전 산업(DA, Digital Appliances) 시장 동향 뉴스 분류 전문가입니다.
입력된 뉴스에 대해 아래 4가지를 JSON 으로 분류하세요.

분류 항목:
1. category: ${CONFIG.categories.join(", ")} 中 1개
2. signal: ${CONFIG.signals.join(", ")} 中 1개
   - New: 기폭제·전환점·신호 (최근 발표·출시·발효)
   - Deep: 구조적 동인·인과 구조 (장기적·근본적 변화)
   - Insight: 함의·승부처 (당사 의사결정에 결정적)
3. relatedBu: ${Object.keys(CONFIG.businessUnits).join(", ")} 中 관련된 모든 사업부 (배열)
4. summary: 3줄 이내 한국어 요약. 다음 규칙 엄수:
   - 첫 문장은 연결어로 시작 (우선/그 결과/한편/이에 따라/종합하면 等)
   - 정량 수치 1개 이상 포함
   - 각 줄 28~36자 내외
   - 모호 표현 금지 (필요/검토/강화)
   - 한자 약어 가능 (時·可·後·內·等)
5. headline: 원문 헤드라인을 Herald 압축형으로 재작성 (30자 이내). 연결어 1개 + 결론 + 수치

분류 결과는 반드시 다음 JSON 스키마로만 출력:
{
  "category": "...",
  "signal": "...",
  "relatedBu": ["..."],
  "headline": "...",
  "summary": "..."
}

JSON 외 어떤 텍스트도 출력 금지. 코드펜스 금지.`;

async function classifyOne(item) {
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
${item.source}`;

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

  const cleaned = text.replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(cleaned);

  if (
    !CONFIG.categories.includes(parsed.category) ||
    !CONFIG.signals.includes(parsed.signal)
  ) {
    throw new Error(
      `분류 결과 검증 실패: category=${parsed.category}, signal=${parsed.signal}`
    );
  }

  return parsed;
}

async function classifyAll(items) {
  const toProcess = items.slice(0, CONFIG.limits.maxArticlesPerRun);
  const classified = [];
  let nextId =
    Math.max(0, ...(await loadExisting()).items.map((i) => i.id || 0)) + 1;

  for (const item of toProcess) {
    try {
      log(`분류 중: ${item.headline.slice(0, 40)}...`);
      const cls = await classifyOne(item);
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
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      log(`  ! 분류 실패, 건너뜀: ${err.message}`);
    }
  }
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
  log("=== DA Market Insight 뉴스 갱신 시작 ===");

  const existing = await loadExisting();
  log(`기존 뉴스 ${existing.items.length}건 로드`);

  const fresh = await fetchAllRss();
  log(`RSS 폴링 총 ${fresh.length}건 수집`);

  const newOnes = dedupe(fresh, existing);
  log(`중복 제거 後 신규 ${newOnes.length}건`);

  if (newOnes.length === 0) {
    log("신규 뉴스 없음, 보존 기간 정리만 수행");
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

  const classified = await classifyAll(newOnes);
  log(`AI 분류 완료: ${classified.length}건`);

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
  log(`news.json 갱신 완료, 총 ${merged.length}건`);
  log("=== 완료 ===");
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
