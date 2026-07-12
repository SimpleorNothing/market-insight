#!/usr/bin/env node
/**
 * build-standalone.mjs — 서버 없이 더블클릭으로 여는 단일 HTML 빌더
 *
 * index.html + assets(css/js) + data(news/archive) + config + 로컬 이미지를
 * 하나의 `mi-local.html` 로 인라인한다. `fetch()` 는 임베드 데이터로 가로채므로
 * 로컬 웹서버(python -m http.server 등) 없이 `file://` 로 바로 열린다.
 *
 * 폰트/아이콘(CDN)·기사 썸네일(외부 URL)은 그대로 두어 파일을 가볍게 유지한다.
 * (인터넷 되는 PC 전제. 완전 오프라인이 필요하면 CDN 도 인라인해야 함.)
 *
 * 실행:  node scripts/build-standalone.mjs
 * 산출:  mi-local.html (레포 루트)
 */

import { readFile, writeFile, readdir, stat } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "mi-local.html");

const r = (p) => readFile(join(ROOT, p), "utf-8");

// ---- 1. 소스 읽기 --------------------------------------------------------
const [indexHtml, styleCss, lensCss, appJs, thumbJs, screeningJs, newsRaw, archiveRaw, configRaw] =
  await Promise.all([
    r("index.html"),
    r("assets/css/style.css"),
    r("assets/css/lens-icons.css"),
    r("assets/js/app.js"),
    r("assets/js/thumb-link.js"),
    r("assets/js/screening-info.js"),
    r("data/news.json"),
    r("data/archive.json"),
    r("scripts/config.json"),
  ]);

// ---- 2. 로컬 이미지 → data URI 맵 ---------------------------------------
async function walk(dir) {
  const out = [];
  for (const name of await readdir(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if ((await stat(join(ROOT, rel))).isDirectory()) out.push(...(await walk(rel)));
    else out.push(rel);
  }
  return out;
}
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };
const imgFiles = (await walk("assets/img")).filter((f) => MIME[f.slice(f.lastIndexOf("."))]);
const dataUriMap = new Map();
for (const f of imgFiles) {
  const buf = await readFile(join(ROOT, f));
  const mime = MIME[f.slice(f.lastIndexOf("."))];
  dataUriMap.set(f, `data:${mime};base64,${buf.toString("base64")}`);
}
// 긴 경로부터 치환(부분 매칭 방지)
const sortedPaths = [...dataUriMap.keys()].sort((a, b) => b.length - a.length);
function inlineImagePaths(text) {
  for (const p of sortedPaths) text = text.split(p).join(dataUriMap.get(p));
  return text;
}

// ---- 3. config 조정: 로컬(file://)에선 프록시 대신 내 키 직접 모드 ------
const config = JSON.parse(configRaw);
config.reportProxyUrl = ""; // 프록시는 file:// origin(null) 을 거부 → 직접 모드 폴백
const configJson = JSON.stringify(config);

// ---- 4. 이미지 경로 인라인 반영 -----------------------------------------
const appJsInlined = inlineImagePaths(appJs);
const newsJson = inlineImagePaths(newsRaw);
const archiveJson = inlineImagePaths(archiveRaw);

// ---- 5. 임베드 데이터 + fetch shim --------------------------------------
// news 본문에 </script> 가 들어가도 조기 종료되지 않도록 이스케이프.
const guard = (s) => s.replace(/<\/(script)/gi, "<\\/$1");
const embedBlock = `
<script>
window.__MI_EMBED = {
  "scripts/config.json": ${guard(configJson)},
  "data/news.json": ${guard(newsJson)},
  "data/archive.json": ${guard(archiveJson)}
};
(function () {
  var E = window.__MI_EMBED;
  var orig = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (u, o) {
    var key = String(u).split("?")[0].replace(/^\\.?\\//, "");
    if (Object.prototype.hasOwnProperty.call(E, key)) {
      var body = E[key];
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(body); },
        text: function () { return Promise.resolve(JSON.stringify(body)); }
      });
    }
    if (orig) return orig(u, o);
    return Promise.reject(new Error("standalone: 외부 요청 불가 " + u));
  };
})();
</script>`;

const scriptBlock = (js) => `<script>\n${guard(inlineImagePaths(js))}\n</script>`;

// ---- 6. index.html 조립 -------------------------------------------------
// 주의: 교체 문자열에 $& / $1 등이 들어있으면 String.replace 가 특수 패턴으로
// 해석하므로(예: app.js 의 정규식 이스케이프 코드), 반드시 함수 리플레이서를 쓴다.
let html = indexHtml;
const sub = (re, out) => { html = html.replace(re, () => out); };

// 로컬 CSS <link> → 인라인 <style>
sub(/<link rel="stylesheet" href="assets\/css\/style\.css[^"]*" \/>/, `<style>\n${styleCss}\n</style>`);
sub(/<link rel="stylesheet" href="assets\/css\/lens-icons\.css[^"]*" \/>/, `<style>\n${lensCss}\n</style>`);

// 로컬 JS <script src> → 임베드 데이터+shim(최초 1회) + 인라인 스크립트
sub(/<script src="assets\/js\/app\.js[^"]*"><\/script>/, `${embedBlock}\n${scriptBlock(appJsInlined)}`);
sub(/<script src="assets\/js\/thumb-link\.js[^"]*"><\/script>/, scriptBlock(thumbJs));
sub(/<script src="assets\/js\/screening-info\.js[^"]*"><\/script>/, scriptBlock(screeningJs));

// 로컬 빌드 표식
sub(/<title>[^<]*<\/title>/, `<title>Market Sensing (로컬)</title>\n  <!-- standalone build: scripts/build-standalone.mjs 로 생성. 원본은 index.html + assets/ -->`);

await writeFile(OUT, html, "utf-8");
const kb = Math.round((Buffer.byteLength(html) / 1024) * 10) / 10;
console.log(`✓ mi-local.html 생성 완료 (${kb} KB, 뉴스 ${JSON.parse(newsRaw).items.length}건, 임베드 이미지 ${imgFiles.length}개)`);
