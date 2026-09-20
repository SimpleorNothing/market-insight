// mi.samsungda.net — Market Sensing 게이트 Worker
//
// 포탈과 같은 SSO 게이트를 통과한 요청만 저장소 콘텐츠를 서빙한다.
// 저장소(SimpleorNothing/market-insight)는 public이므로 raw.githubusercontent.com에서
// 익명으로 그대로 읽어 돌려준다(레포 자체가 진실원 — Actions가 주기적으로 data/news.json을 갱신).
//
// /data/* 는 로그인 없이 기계(다른 Worker·GitHub Actions)도 그대로 읽는다(OPEN_PATHS).
//
// 배포:
//   cd gate && npx wrangler deploy
//   npx wrangler secret put SITE_PASSWORD   # 포탈과 "같은 값"
// DNS: mi.samsungda.net 이 GitHub Pages를 가리키고 있으면, Custom Domain을
//      이 Worker로 붙일 때 기존 DNS 레코드를 대체해야 한다(대시보드에서 교체 승인).

import { guard } from "./gate.js";

const OWNER = "SimpleorNothing";
const REPO = "market-insight";
const BRANCH = "main";
const RAW = "https://raw.githubusercontent.com/" + OWNER + "/" + REPO + "/" + BRANCH;

// /data/* 는 사람 로그인 없이도 서빙(기계 소비 경로).
const OPEN_PATHS = ["/data/"];

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

    if (!env.SITE_PASSWORD) {
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

    const upstream = await fetch(RAW + encoded, {
      cf: { cacheTtl: 60, cacheEverything: true },
      headers: { "user-agent": "samsungda-mi-gate" },
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
