import assert from "node:assert/strict";

process.env.DRY_RUN = "1";
const {
  CONFIG,
  strongPrefilterReason,
  cachedDecision,
  setCacheEntry,
} = await import("./fetch-news.js");

assert.ok(strongPrefilterReason("BTS 보이콧에 그래미 부문 재검토"));
assert.ok(strongPrefilterReason("서울 아파트 분양가와 주택 매물 동향"));
assert.equal(strongPrefilterReason("LG전자 브라질 가전공장 생산 확대"), null);
assert.equal(strongPrefilterReason("Whirlpool earnings and appliance demand"), null);
assert.equal(strongPrefilterReason("LG전자 목재 모듈러 주택 사업 진출"), null);

const cache = { schemaVersion: "v1", entries: {} };
const item = {
  headline: "관련 없는 행사 기사",
  rawContent: "본문 A",
  link: "https://example.com/a?utm_source=test",
};
setCacheEntry(cache, item, { status: "skip", reason: "model_skip" });
assert.equal(cachedDecision(item, cache), "skip");
assert.equal(cachedDecision({ ...item, rawContent: "본문 B" }, cache), null);

const key = Object.keys(cache.entries)[0];
cache.entries[key].classifierVersion = "old-version";
assert.notEqual(cache.entries[key].classifierVersion, CONFIG.processingCache.classifierVersion);
assert.equal(cachedDecision(item, cache), null);

console.log("cost guard tests passed");
