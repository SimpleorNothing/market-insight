#!/usr/bin/env node
/**
 * WORK_GUIDE.md 이력 자동 갱신 스크립트
 * GitHub Actions에서 pull_request(closed, merged) 이벤트로 실행.
 * 머지된 PR의 번호·제목·일자(KST)를 §7 이력 표(해당 월 섹션) 맨 위에 삽입한다.
 * 월 섹션이 없으면 새로 만든다. 자동 갱신 커밋은 직접 push라 재트리거 없음.
 */
import fs from "node:fs";

const GUIDE_PATH = "docs/WORK_GUIDE.md";

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath || !fs.existsSync(eventPath)) {
  console.error("GITHUB_EVENT_PATH 없음 — Actions 외 실행은 지원하지 않음");
  process.exit(1);
}

const event = JSON.parse(fs.readFileSync(eventPath, "utf-8"));
const pr = event.pull_request;
if (!pr || !pr.merged) {
  console.log("머지된 PR 아님 — 스킵");
  process.exit(0);
}

const title = String(pr.title || "").trim().replace(/\|/g, "／");
const number = pr.number;

// merged_at(UTC) → KST 변환
const merged = new Date(pr.merged_at || Date.now());
const kst = new Date(merged.getTime() + 9 * 60 * 60 * 1000);
const yyyy = kst.getUTCFullYear();
const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
const dd = String(kst.getUTCDate()).padStart(2, "0");

const monthHeader = `### ${yyyy}-${mm}`;
const tableHead = "| PR | 일자 | 내용 |\n|---|---|---|";
const newRow = `| #${number} | ${mm}-${dd} | ${title} |`;

let doc = fs.readFileSync(GUIDE_PATH, "utf-8");

// 이미 같은 PR 행이 있으면 스킵 (재실행 안전)
if (doc.includes(`| #${number} |`)) {
  console.log(`PR #${number} 행이 이미 존재 — 스킵`);
  process.exit(0);
}

if (doc.includes(monthHeader)) {
  // 해당 월 섹션의 표 구분선 바로 다음에 새 행 삽입
  const idx = doc.indexOf(monthHeader);
  const sepIdx = doc.indexOf("|---|---|---|", idx);
  if (sepIdx === -1) {
    console.error(`${monthHeader} 섹션에 표가 없음 — 수동 확인 필요`);
    process.exit(1);
  }
  const lineEnd = doc.indexOf("\n", sepIdx);
  doc = doc.slice(0, lineEnd + 1) + newRow + "\n" + doc.slice(lineEnd + 1);
} else {
  // 새 월 섹션을 이력 안내 blockquote 바로 아래에 생성
  const anchor = "맨 위에 추가할 것.";
  const aIdx = doc.indexOf(anchor);
  if (aIdx === -1) {
    console.error("이력 섹션 앵커를 찾지 못함 — 수동 확인 필요");
    process.exit(1);
  }
  const lineEnd = doc.indexOf("\n", aIdx);
  const block = `\n${monthHeader}\n${tableHead}\n${newRow}\n`;
  doc = doc.slice(0, lineEnd + 1) + block + doc.slice(lineEnd + 1);
}

fs.writeFileSync(GUIDE_PATH, doc);
console.log(`WORK_GUIDE.md 갱신: PR #${number} (${yyyy}-${mm}-${dd}) ${title}`);
