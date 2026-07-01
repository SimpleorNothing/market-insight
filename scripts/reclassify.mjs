// 기존 news.json 기사를 최신 분류 프롬프트로 다시 분류(라벨만 갱신).
//
// 갱신: lens, competitors, products, factors → impact/grade 재계산
// 유지: id, headline, summary, tags, source, publishedAt, url
//   (원문 본문이 저장돼 있지 않아 headline+summary 를 분류 입력으로 사용.
//    headline·summary·tags 는 재생성하면 정보가 열화되므로 원본 보존.)
//
// 인증: ANTHROPIC_API_KEY 없으면 GEN_ANTHROPIC_KEY 사용.
// 사용: node scripts/reclassify.mjs [--dry] [--limit=N] [--concurrency=N]
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// fetch-news.js 가 import 시점에 Anthropic 클라이언트를 생성하므로 그 前에 키 주입
if (!process.env.ANTHROPIC_API_KEY && process.env.GEN_ANTHROPIC_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.GEN_ANTHROPIC_KEY;
}

const { classifyOne, computeImpact, gradeFromImpact } = await import(
  "./fetch-news.js"
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEWS_PATH = join(ROOT, "data", "news.json");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity;
const CONCURRENCY = Number((args.find((a) => a.startsWith("--concurrency=")) || "").split("=")[1]) || 6;

function log(m) {
  console.log(`[${new Date().toISOString()}] ${m}`);
}

// 동시성 제한 실행기
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })
  );
  return results;
}

const data = JSON.parse(await readFile(NEWS_PATH, "utf8"));
const targets = data.items.filter((n) => n.lens !== "skip").slice(0, LIMIT);
log(`재분류 대상 ${targets.length}건 (전체 ${data.items.length}건), 동시성 ${CONCURRENCY}`);

let updated = 0, skipKept = 0, failed = 0, unchanged = 0;
const lensChanges = [];
const compFills = [];
const compRemovals = [];

await mapWithConcurrency(targets, CONCURRENCY, async (n) => {
  // fetch-news.js 의 classifyOne 이 기대하는 형태로 pseudo-item 구성
  const item = {
    headline: n.headline || "",
    rawContent: n.summary || "", // 원문 본문 부재 → 요약을 발췌로 사용
    publishedAt: n.publishedAt,
    source: n.source?.name || "",
    region: n.region || "",
  };
  try {
    const cls = await classifyOne(item);
    if (cls.lens === "skip") {
      skipKept++; // 재분류가 skip 판정해도 기존 레코드는 삭제하지 않고 그대로 둠
      return;
    }
    const before = { lens: n.lens, competitors: [...(n.competitors || [])] };
    const impact = computeImpact(cls.factors);
    const grade = gradeFromImpact(impact);

    // lens·factors·grade 는 재판정(교체). competitors·products 는 비파괴 병합(union):
    // 원문 본문 부재로 재분류 입력이 headline+summary 뿐이라, 본문에만 있던 회사·제품이
    // 사라지는 회귀를 막기 위해 기존 값은 유지하고 새로 찾은 것만 추가한다.
    const unionKeep = (prev, next) => [
      ...prev,
      ...next.filter((x) => !prev.includes(x)),
    ];
    n.lens = cls.lens;
    n.products = unionKeep(n.products || [], cls.products || []);
    n.competitors = unionKeep(n.competitors || [], cls.competitors || []);
    n.factors = cls.factors;
    n.impact = impact;
    n.grade = grade;

    const compBefore = JSON.stringify(before.competitors);
    const compAfter = JSON.stringify(n.competitors);
    const removed = before.competitors.filter((c) => !n.competitors.includes(c));
    if (before.lens !== n.lens || compBefore !== compAfter) {
      updated++;
      if (before.lens !== n.lens) lensChanges.push(`  lens ${before.lens}→${n.lens} | ${n.headline}`);
      if (compBefore !== compAfter) compFills.push(`  ${compBefore}→${compAfter} | ${n.headline}`);
      if (removed.length) compRemovals.push(`  -[${removed.join(",")}] ${compBefore}→${compAfter} | ${n.headline}`);
    } else {
      unchanged++;
    }
  } catch (e) {
    failed++;
    log(`  ! 실패: ${(n.headline || "").slice(0, 40)} — ${e.message}`);
  }
});

log(`완료: 변경 ${updated}건, 무변화 ${unchanged}건, skip판정(유지) ${skipKept}건, 실패 ${failed}건`);
log(`lens 변경 ${lensChanges.length}건 / competitors 변경 ${compFills.length}건 / ★competitors 제거 발생 ${compRemovals.length}건`);
console.log("=== competitors 제거(회귀 위험) ===");
compRemovals.slice(0, 30).forEach((s) => console.log(s));

if (DRY) {
  log("[--dry] 파일 미기록");
} else {
  data.updatedAt = new Date().toISOString();
  await writeFile(NEWS_PATH, JSON.stringify(data, null, 2));
  log(`news.json 갱신 완료`);
}
