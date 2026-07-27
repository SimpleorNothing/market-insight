/**
 * 묶음 분류(1콜 다기사) 품질 검증 도구 — 파이프라인 미적용, 수동 실행 전용
 *
 * 목적: 호출당 기사 K건을 묶어 분류하면 시스템 프롬프트(~8천 토큰)가 K건에
 * 분산되어 입력 비용이 크게 줄지만, ① factors 점수 중앙값 수렴, ② 인접 기사
 * 간 summary 교차 오염(소스 충실성 원칙 위반) 위험이 있다. 이 스크립트는
 * 동일 기사 셋에 대해 [단건 분류 vs 묶음 분류]를 실제 호출로 비교해
 * 도입 가부 판단 근거를 만든다.
 *
 * 사용법:
 *   cd scripts && ANTHROPIC_API_KEY=sk-... node validate-grouping.mjs
 *
 * 환경변수:
 *   VALIDATE_N     검증 기사 수 (기본 15)
 *   GROUP_SIZE     묶음 크기 (기본 5)
 *
 * 판정 가이드(권장 기준):
 *   - lens 일치율 ≥ 90%
 *   - factors 평균 절대차 ≤ 0.5
 *   - summary 교차 오염 0건  ← 하나라도 있으면 도입 보류 또는 GROUP_SIZE 축소
 */

import Anthropic from "@anthropic-ai/sdk";
import Parser from "rss-parser";
import {
  CONFIG,
  CLASSIFY_SYSTEM,
  classifyOne,
  buildUserPrompt,
} from "./fetch-news.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY 가 필요합니다.");
  process.exit(1);
}

const N = Number(process.env.VALIDATE_N || 15);
const GROUP_SIZE = Number(process.env.GROUP_SIZE || 5);
const MODEL = "claude-haiku-4-5-20251001";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const rssParser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "DA-Market-Insight/2.0" },
});

// ── 샘플 수집 (fetch-news.js fetchAllRss 와 동일 shape 의 간이 재현) ──
async function collectSample() {
  const all = [];
  for (const source of CONFIG.rssSources) {
    if (all.length >= N * 2) break;
    try {
      const feed = await rssParser.parseURL(source.url);
      for (const it of feed.items.slice(0, CONFIG.limits.maxArticlesPerSource)) {
        const headline = (it.title || "").trim();
        if (!it.link || headline.length < CONFIG.limits.minHeadlineLength) continue;
        all.push({
          source: source.name,
          region: source.region,
          headline,
          link: it.link,
          publishedAt: it.isoDate || it.pubDate || new Date().toISOString(),
          rawContent: (it.contentSnippet || it.content || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 800),
        });
      }
    } catch (e) {
      console.error(`RSS 실패(${source.name}): ${e.message}`);
    }
  }
  // 서로 다른 출처가 섞이도록 앞에서부터 N건
  return all.slice(0, N);
}

// ── 묶음 분류 (도입 시 실제 구현안과 동일한 프롬프트 구조) ──
async function classifyGroup(group) {
  const blocks = group
    .map((item, i) => `===== 기사 ${i + 1} =====\n${buildUserPrompt(item)}`)
    .join("\n\n");
  const userPrompt =
    `아래 ${group.length}건의 기사를 각각 독립적으로 분류하십시오.\n` +
    `각 기사의 요약·태그·경쟁사는 반드시 해당 기사 원문 발췌에만 근거해야 하며,\n` +
    `다른 기사의 내용을 절대 섞지 마십시오.\n` +
    `출력은 기사 순서대로 JSON 객체를 담은 JSON 배열 하나만 반환하십시오.\n\n` +
    blocks;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 800 * group.length,
    system: [
      { type: "text", text: CLASSIFY_SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });

  let text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```json\s*|\s*```$/g, "")
    .trim();
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s < 0 || e <= s) throw new Error("JSON 배열 미발견");
  const arr = JSON.parse(text.slice(s, e + 1));
  if (!Array.isArray(arr) || arr.length !== group.length) {
    throw new Error(`배열 길이 불일치: ${arr.length} vs ${group.length}`);
  }
  return { arr, usage: res.usage };
}

// ── 교차 오염 검사용 회사명 매처 (config 기반 간이 검사) ──
function companyNamesIn(text) {
  const t = (text || "").toLowerCase();
  const found = new Set();
  const add = (canonical, name) => {
    if (name && t.includes(name.toLowerCase())) found.add(canonical);
  };
  for (const c of CONFIG.competitors) {
    add(c, c);
    for (const b of CONFIG.competitorBrands?.[c] || []) add(c, b);
  }
  for (const [alias, canonical] of Object.entries(CONFIG.competitorAliases || {})) {
    if (CONFIG.competitors.includes(canonical)) add(canonical, alias);
  }
  return found;
}

// ── 실행 ──
const items = await collectSample();
if (items.length < GROUP_SIZE) {
  console.error(`샘플 부족(${items.length}건). RSS 접근 환경에서 실행하십시오.`);
  process.exit(1);
}
console.log(`샘플 ${items.length}건 수집. 단건 기준선 분류 시작...\n`);

const baseline = new Map();
for (const item of items) {
  try {
    baseline.set(item, await classifyOne(item));
  } catch (e) {
    baseline.set(item, { error: e.message });
  }
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`묶음 분류 시작 (크기 ${GROUP_SIZE})...\n`);
const grouped = new Map();
let groupUsage = { input_tokens: 0, output_tokens: 0 };
for (let i = 0; i < items.length; i += GROUP_SIZE) {
  const group = items.slice(i, i + GROUP_SIZE);
  try {
    const { arr, usage } = await classifyGroup(group);
    groupUsage.input_tokens += usage?.input_tokens || 0;
    groupUsage.output_tokens += usage?.output_tokens || 0;
    for (let j = 0; j < group.length; j++) {
      try {
        // 단건과 동일한 검증 파이프라인 통과 (retry=true: 실패 시 라이브 재호출 없이 기록)
        grouped.set(
          group[j],
          await classifyOne(group[j], true, "", JSON.stringify(arr[j]))
        );
      } catch (e) {
        grouped.set(group[j], { error: e.message });
      }
    }
  } catch (e) {
    for (const g of group) grouped.set(g, { error: `그룹 실패: ${e.message}` });
  }
  await new Promise((r) => setTimeout(r, 400));
}

// ── 비교 리포트 ──
const FACTORS = ["salesRelevance", "timeUrgency", "marketSize", "sourceReliability"];
let lensMatch = 0;
let comparable = 0;
let factorDiffSum = 0;
let factorDiffN = 0;
let compMatch = 0;
const contaminations = [];
const rows = [];

for (let i = 0; i < items.length; i += GROUP_SIZE) {
  const group = items.slice(i, i + GROUP_SIZE);
  for (const item of group) {
    const b = baseline.get(item);
    const g = grouped.get(item);
    const short = item.headline.slice(0, 28);
    if (b?.error || g?.error) {
      rows.push(`| ${short} | 오류 | ${b?.error || "-"} / ${g?.error || "-"} |`);
      continue;
    }
    const bothSkip = b.lens === "skip" && g.lens === "skip";
    if (bothSkip) {
      comparable++;
      lensMatch++;
      rows.push(`| ${short} | skip=skip | - |`);
      continue;
    }
    if (b.lens === "skip" || g.lens === "skip") {
      comparable++;
      rows.push(`| ${short} | skip 불일치(단건:${b.lens}/묶음:${g.lens}) | ⚠ |`);
      continue;
    }
    comparable++;
    if (b.lens === g.lens) lensMatch++;
    let fd = 0;
    for (const f of FACTORS) {
      fd += Math.abs((b.factors?.[f] || 0) - (g.factors?.[f] || 0));
      factorDiffN++;
    }
    factorDiffSum += fd;
    const bc = new Set(b.competitors || []);
    const gc = new Set(g.competitors || []);
    const compEq = bc.size === gc.size && [...bc].every((x) => gc.has(x));
    if (compEq) compMatch++;

    // 교차 오염: 자기 발췌에 없고 그룹 동료 발췌에는 있는 회사명이 묶음 요약에 등장?
    const own = companyNamesIn(`${item.headline}\n${item.rawContent}`);
    const mates = new Set();
    for (const m of group) {
      if (m === item) continue;
      for (const c of companyNamesIn(`${m.headline}\n${m.rawContent}`)) mates.add(c);
    }
    const gSummaryText =
      `${g.summary || ""}\n` +
      (g.summaryPoints || []).map((p) => p.text).join("\n");
    const leaked = [...companyNamesIn(gSummaryText)].filter(
      (c) => !own.has(c) && mates.has(c)
    );
    if (leaked.length) {
      contaminations.push({ headline: item.headline, leaked });
    }
    rows.push(
      `| ${short} | lens ${b.lens === g.lens ? "=" : `≠(${b.lens}/${g.lens})`} / factor차 ${(fd / FACTORS.length).toFixed(2)} / 경쟁사 ${compEq ? "=" : "≠"} | ${leaked.length ? "🚨 오염: " + leaked.join(",") : "-"} |`
    );
  }
}

console.log(`\n## 묶음 분류 검증 리포트 (N=${items.length}, GROUP_SIZE=${GROUP_SIZE})\n`);
console.log(`| 기사 | 비교 | 오염 |`);
console.log(`|---|---|---|`);
for (const r of rows) console.log(r);
console.log(`\n### 집계`);
console.log(`- 비교 가능: ${comparable}건`);
console.log(`- lens 일치율: ${comparable ? ((lensMatch / comparable) * 100).toFixed(1) : "-"}% (기준 ≥90%)`);
console.log(`- factors 평균 절대차: ${factorDiffN ? (factorDiffSum / factorDiffN).toFixed(3) : "-"} (기준 ≤0.5)`);
console.log(`- competitors 집합 일치: ${compMatch}/${comparable}`);
console.log(`- summary 교차 오염: ${contaminations.length}건 (기준 0건)`);
for (const c of contaminations) {
  console.log(`    🚨 "${c.headline.slice(0, 40)}" ← 유입: ${c.leaked.join(", ")}`);
}
console.log(`\n### 묶음 호출 토큰 (참고)`);
console.log(`- 입력 ${groupUsage.input_tokens} / 출력 ${groupUsage.output_tokens}`);
console.log(
  `- 단건 대비 입력 절감 추정: 시스템 프롬프트가 호출 수 1/${GROUP_SIZE}로 분산\n`
);
console.log(
  contaminations.length
    ? "판정: 오염 검출 → 도입 보류 또는 GROUP_SIZE 축소 후 재검증 권장"
    : "판정: 오염 0건 — 나머지 지표가 기준 내면 도입 가능"
);
