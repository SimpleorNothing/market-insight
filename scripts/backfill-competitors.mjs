// 기존 news.json 백필: 헤드라인·요약에 경쟁사(또는 하위 브랜드) 회사명이
// 실제 문자열로 거명됐는데 competitors 에 누락된 레코드를 정정한다.
//
// - lens 값과 무관하게, 거명된 회사만 추가한다(정정은 '추가'만, 삭제 없음).
// - 하위 브랜드는 모기업 경쟁사명으로 매핑(config.competitorBrands).
// - 기존 competitors 순서는 유지하고, 새로 찾은 회사만 뒤에 덧붙인다.
//
// 사용: node scripts/backfill-competitors.mjs [--dry]
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEWS_PATH = join(ROOT, "data", "news.json");
const CONFIG = JSON.parse(await readFile(join(ROOT, "scripts", "config.json"), "utf8"));
const DRY = process.argv.includes("--dry");

// 영문 짧은 브랜드 토큰 중 일반 단어·지명과 충돌해 오탐을 내는 것들은 제외.
// (예: "York" → "New York", "Coleman"/"Candy"/"Neff"/"Bryant" 등 일반명사·인명)
const AMBIGUOUS = new Set([
  "York", "Coleman", "Candy", "Neff", "Bryant", "Amana", "Ducane",
  "American Standard(공조)",
]);

// 회사명·하위 브랜드 문자열 → 모기업 경쟁사명
const nameToParent = new Map();
for (const c of CONFIG.competitors) nameToParent.set(c, c);
for (const [parent, brands] of Object.entries(CONFIG.competitorBrands || {})) {
  if (parent === "_comment") continue;
  for (const b of brands) nameToParent.set(b, parent);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 이름이 텍스트에 거명됐는지: 한글/비ASCII는 부분일치, 영문은 단어경계+대소문자 구분
function isNamed(name, text) {
  if (AMBIGUOUS.has(name)) return false;
  if (/[^\x00-\x7F]/.test(name)) return text.includes(name);
  return new RegExp(`\\b${escapeRe(name)}\\b`).test(text);
}

const data = JSON.parse(await readFile(NEWS_PATH, "utf8"));
let changed = 0;
const samples = [];

for (const n of data.items) {
  if (n.lens === "skip") continue;
  const text = `${n.headline || ""} ${n.summary || ""}`;
  const existing = new Set(n.competitors || []);
  const added = [];
  for (const [name, parent] of nameToParent) {
    if (!CONFIG.competitors.includes(parent)) continue;
    if (existing.has(parent) || added.includes(parent)) continue;
    if (isNamed(name, text)) added.push(parent);
  }
  if (added.length) {
    const before = JSON.stringify(n.competitors || []);
    n.competitors = [...(n.competitors || []), ...added];
    changed++;
    if (samples.length < 15) {
      samples.push(`  [${n.lens}] ${n.headline}\n     ${before} -> ${JSON.stringify(n.competitors)}`);
    }
  }
}

console.log(`경쟁사 추가된 레코드: ${changed} / ${data.items.length}`);
samples.forEach((s) => console.log(s));

if (DRY) {
  console.log("\n[--dry] 파일 미기록");
} else {
  await writeFile(NEWS_PATH, JSON.stringify(data, null, 2));
  console.log(`\nnews.json 갱신 완료 (${changed}건 정정)`);
}
