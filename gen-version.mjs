#!/usr/bin/env node
/* gen-version.mjs — 빌드 시 git 이력 → version.json 생성
 * 사용:  node gen-version.mjs [출력경로=version.json] [로그개수=8]
 * 빌드 단계엔 .git 이 항상 있으므로 런타임 git 의존성(반영 안 됨 문제)을 제거한다.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'version.json';
const N = parseInt(process.argv[3] || '8', 10);

function toKstIso(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}:${f.second}+09:00`;
}
const clean = (s) => s.replace(/\s*\(#\d+\)\s*$/, '').trim();

let log = [];
try {
  const raw = execSync(`git log -${N} --format=%H%x1f%cI%x1f%s`, { encoding: 'utf8' }).trim();
  log = raw.split('\n').filter(Boolean).map((line) => {
    const [hash, iso, subject] = line.split('\x1f');
    return { commit: hash.slice(0, 7), at: toKstIso(iso), summary: clean(subject) };
  });
} catch (e) {
  console.error('[gen-version] git 조회 실패:', e.message);
}

const top = log[0] || { at: toKstIso(new Date().toISOString()), summary: '', commit: '' };
const out = { updated_at: top.at, summary: top.summary, commit: top.commit, log };

mkdirSync(dirname(OUT) || '.', { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`[gen-version] ${OUT} <- ${out.updated_at} (${out.summary})`);
