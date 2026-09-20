// mi.samsungda.net — Market Sensing 게이트 Worker
//
// 저장소(SimpleorNothing/market-insight)가 비공개라 GitHub Pages를 쓸 수 없으므로,
// 이 Worker가 mi.samsungda.net 전체를 직접 서빙한다.
// 포탈과 같은 SSO 게이트를 통과한 요청만, 읽기 전용 토큰으로 GitHub 저장소에서
// 파일을 읽어 돌려준다(레포 자체가 진실원 — Actions가 주기적으로 data/news.json을 갱신).
//
// 배포:
//   cd gate && npx wrangler deploy
//   npx wrangler secret put SITE_PASSWORD   # 포탈과 "같은 값"
//   npx wrangler secret put GITHUB_TOKEN    # market-insight 저장소 Contents: Read-only 전용 토큰
// DNS: mi.samsungda.net 이 GitHub Pages를 가리키고 있으면, Custom Domain을
//      이 Worker로 붙일 때 기존 DNS 레코드를 대체해야 한다(대시보드에서 교체 승인).

import { guard } from "./gate.js";

const OWNER = "SimpleorNothing";
const REPO = "market-insight";
const BRANCH = "main";
const API = "https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents";

// 저장소가 비공개이므로 게이트를 우회하는 경로는 없다(예전의 /data/ 공개 예외 제거).
// 기계 소비용 클라이언트가 /data/ 를 읽어야 하면 별도 토큰 방식으로 추가할 것.
const OPEN_PATHS = [];

const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  woff2: "font/woff2",
};

function contentType(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return TYPES[ext] || "application/octet-stream";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 비공개 데이터를 서빙하므로 fail-closed: 필수 secret이 없으면 열지 않는다.
    if (!env.SITE_PASSWORD || !env.GITHUB_TOKEN) {
      return new Response("Service not configured", { status: 503 });
    }

    const blocked = await guard(request, env, url, {
      title: "Market Sensing",
      openPaths: OPEN_PATHS,
    });
    if (blocked) return blocked;

    let path = url.pathname;
    if (path === "" || path === "/") path = "/index.html";
    if (path.endsWith("/")) path += "index.html";
    if (path.includes("..")) return new Response("Not found", { status: 404 });

    let encoded;
    try {
      encoded = path
        .split("/")
        .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
        .join("/");
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const upstream = await fetch(API + encoded + "?ref=" + BRANCH, {
      cf: { cacheTtl: 60, cacheEverything: true },
      headers: {
        authorization: "Bearer " + env.GITHUB_TOKEN,
        accept: "application/vnd.github.raw+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "samsungda-mi-gate",
      },
    });
    if (!upstream.ok) {
      return new Response("Not found", { status: upstream.status === 404 ? 404 : 502 });
    }

    const headers = new Headers();
    headers.set("content-type", contentType(path));
    headers.set("cache-control", path.endsWith(".json") ? "private, max-age=60" : "no-cache, must-revalidate");
    headers.set("x-content-type-options", "nosniff");
    return new Response(upstream.body, { status: 200, headers });
  },
};
