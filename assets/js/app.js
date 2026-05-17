/**
 * DA Market Insight
 * 뉴스 수집·정리 및 사업부 영향 리포트 생성 보드
 *
 * 데이터 소스:
 *   - data/news.json (GitHub Actions가 1시간 주기로 자동 갱신)
 *
 * 백엔드 연결 시 수정 필요 지점:
 *   - generateReport() → 실제 리포트 생성 API 호출로 교체
 */

// ===== News data (loaded from data/news.json) =====
let NEWS_DATA = [];
let NEWS_UPDATED_AT = null;

// ===== Category & signal definitions =====
const CATEGORIES = ["소비자", "기술", "경쟁사", "정책", "거시"];
const SIGNAL_ORDER = { New: 1, Deep: 2, Insight: 3 };

// ===== State =====
const state = {
  category: "전체",
  search: "",
  bu: "all",
  period: 7,
  selectedNews: null,
};

// ===== Utilities =====
function timeAgo(isoString) {
  const now = new Date();
  const then = new Date(isoString);
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 60) return `${diffMin}분 전`;
  if (diffHr < 24) return `${diffHr}시간 전`;
  if (diffDay < 7) return `${diffDay}일 전`;
  return then.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function formatLastUpdated() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `'${yy}.${m}.${d} ${hh}:${mm} 갱신`;
}

function isWithinPeriod(isoString, days) {
  const then = new Date(isoString);
  const now = new Date();
  const diffDay = (now - then) / (1000 * 60 * 60 * 24);
  return diffDay <= days;
}

function buMatches(news, buFilter) {
  if (buFilter === "all") return true;
  const buMap = {
    ref: "냉장고",
    wm: "세탁기",
    ac: "에어컨",
    kitchen: "주방가전",
  };
  return news.relatedBu.includes(buMap[buFilter]);
}

// ===== Filtering =====
function getFilteredNews() {
  return NEWS_DATA.filter((n) => {
    if (state.category !== "전체" && n.category !== state.category) return false;
    if (!isWithinPeriod(n.publishedAt, state.period)) return false;
    if (!buMatches(n, state.bu)) return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = (n.headline + " " + n.summary).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

// ===== Rendering =====
function renderStats() {
  const all = NEWS_DATA.filter((n) => isWithinPeriod(n.publishedAt, state.period));
  document.getElementById("statTotal").textContent = `${all.length}건`;
  document.getElementById("statNew").textContent =
    all.filter((n) => n.signal === "New").length + "건";
  document.getElementById("statDeep").textContent =
    all.filter((n) => n.signal === "Deep").length + "건";
  document.getElementById("statInsight").textContent =
    all.filter((n) => n.signal === "Insight").length + "건";
}

function renderCategoryTabs() {
  const tabs = document.getElementById("categoryTabs");
  const all = NEWS_DATA.filter((n) => isWithinPeriod(n.publishedAt, state.period));

  const totalCount = all.length;
  const counts = CATEGORIES.reduce((acc, c) => {
    acc[c] = all.filter((n) => n.category === c).length;
    return acc;
  }, {});

  tabs.innerHTML = "";
  const allBtn = createTabButton("전체", totalCount);
  tabs.appendChild(allBtn);
  CATEGORIES.forEach((c) => {
    tabs.appendChild(createTabButton(c, counts[c]));
  });
}

function createTabButton(label, count) {
  const btn = document.createElement("button");
  btn.className = "tab-btn";
  if (state.category === label) btn.classList.add("tab-btn--active");
  btn.innerHTML = `<span>${label}</span><span class="tab-btn__count">${count}</span>`;
  btn.addEventListener("click", () => {
    state.category = label;
    renderCategoryTabs();
    renderNewsGrid();
  });
  return btn;
}

function renderNewsGrid() {
  const grid = document.getElementById("newsGrid");
  const empty = document.getElementById("emptyState");
  const items = getFilteredNews();

  if (items.length === 0) {
    grid.innerHTML = "";
    grid.hidden = true;
    empty.hidden = false;
    return;
  }
  grid.hidden = false;
  empty.hidden = true;

  grid.innerHTML = items.map((n) => renderCard(n)).join("");

  grid.querySelectorAll("[data-report-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = Number(e.currentTarget.dataset.reportId);
      openReportModal(id);
    });
  });
}

function renderCard(n) {
  return `
    <article class="news-card">
      <div class="news-card__badges">
        <span class="badge badge--cat-${n.category}">${n.category}</span>
        <span class="badge badge--sig-${n.signal}">${n.signal}</span>
      </div>
      <h3 class="news-card__headline">${escapeHtml(n.headline)}</h3>
      <p class="news-card__summary">${escapeHtml(n.summary)}</p>
      <div class="news-card__footer">
        <span class="news-card__meta">
          <i class="ti ti-clock" aria-hidden="true"></i>
          <span>${timeAgo(n.publishedAt)}</span>
          <span aria-hidden="true">·</span>
          <a href="${n.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.source)}</a>
        </span>
        <button class="news-card__action" data-report-id="${n.id}">리포트 ↗</button>
      </div>
    </article>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===== Modal =====
function openReportModal(id) {
  const news = NEWS_DATA.find((n) => n.id === id);
  if (!news) return;
  state.selectedNews = news;

  document.getElementById("modalNewsPreview").innerHTML = `
    <p class="modal__news-preview-label">선택된 뉴스</p>
    <p class="modal__news-preview-headline">${escapeHtml(news.headline)}</p>
  `;

  const checkboxes = document.querySelectorAll('#buCheckboxGroup input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    cb.checked = news.relatedBu.includes(cb.value);
  });

  document.getElementById("reportModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeReportModal() {
  document.getElementById("reportModal").hidden = true;
  document.body.style.overflow = "";
  state.selectedNews = null;
}

// ===== Report generation =====
const REPORT_SYSTEM_PROMPT = `당신은 'Herald'입니다. 가전 산업 시장 동향 뉴스 기반 사업부 영향 1페이지 리포트 작성 전문가입니다.

【출력 형식 — 절대 규칙】
- 응답은 반드시 순수 JSON 객체 1개만 출력
- 코드펜스, 주석, 추가 설명 일체 금지
- 거절 응답·영문 회피 응답 일체 금지

【리포트 구조】
1페이지 분량. 다음 3개 본문 섹션 + 마무리:
1. 핵심 신호 (signal): 뉴스 사실 요약
2. 당사 기회 (opportunity): 선택 사업부에 미치는 기회
3. 당사 위협 (threat): 선택 사업부에 미치는 위협
4. implication: 마무리 시사점

【작성 규칙】
- 헤드라인 30자 이내, 결론 + 수치
- 첫머리 연결어 (우선/그 결과/한편/이에 따라/종합하면/가장 먼저)
- L2 본문은 28~36자 내외, 정량 수치 1개 이상 권장
- '당사' 호칭 통일 (자사 금지)
- 한자 약어 가능 (時·可·後·內·等)
- 모호 표현 금지 (필요·검토·강화·추적)
- 기회·위협 섹션은 선택 사업부의 KPI·경쟁사를 반드시 1개 이상 참조
- 마무리 시사점: '당사' 주어 시작, 액션 동사 종결 (대응·확장·재편·선점·차단 等)

【출력 스키마】
{
  "subtitle": "뉴스 핵심 한 줄 (15자 이내)",
  "sections": [
    {
      "type": "signal",
      "headline": "□ 헤드라인",
      "items": [
        {"level": 2, "text": "L2 본문"},
        {"level": 2, "text": "L2 본문"}
      ]
    },
    {
      "type": "opportunity",
      "headline": "□ 헤드라인",
      "items": [{"level": 2, "text": "..."}]
    },
    {
      "type": "threat",
      "headline": "□ 헤드라인",
      "items": [{"level": 2, "text": "..."}]
    }
  ],
  "implication": "마무리 시사점 (당사 주어, 액션 종결)"
}

JSON 외 어떤 텍스트도 출력 금지.`;

let BU_CONTEXTS = {};

async function loadConfig() {
  try {
    const res = await fetch("scripts/config.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    BU_CONTEXTS = cfg.businessUnits || {};
  } catch (err) {
    console.warn("config.json 로드 실패, 기본 컨텍스트 사용:", err);
    BU_CONTEXTS = {};
  }
}

function getApiKey() {
  return localStorage.getItem("anthropic_api_key");
}

function setApiKey(key) {
  localStorage.setItem("anthropic_api_key", key.trim());
}

function clearApiKey() {
  localStorage.removeItem("anthropic_api_key");
}

function promptForApiKey() {
  const key = prompt(
    "Anthropic API 키를 입력해 주세요.\n\n" +
      "형식: sk-ant-api03-...\n" +
      "발급: https://console.anthropic.com/settings/keys\n\n" +
      "입력한 키는 본인 브라우저에만 저장되며 외부로 전송되지 않습니다."
  );
  if (!key) return null;
  const trimmed = key.trim();
  if (!trimmed.startsWith("sk-ant-")) {
    showToast("올바른 형식의 API 키가 아닙니다", false);
    return null;
  }
  setApiKey(trimmed);
  return trimmed;
}

async function callClaudeForReport(apiKey, news, businessUnits) {
  const buContextLines = businessUnits.map((bu) => {
    const c = BU_CONTEXTS[bu] || {};
    return (
      `${bu}:\n` +
      `  주요 제품: ${(c.keywords || []).slice(0, 6).join(", ") || "(미등록)"}\n` +
      `  주요 경쟁사: ${(c.competitors || []).join(", ") || "(미등록)"}\n` +
      `  핵심 KPI: ${(c.kpis || []).join(", ") || "(미등록)"}`
    );
  });

  const userPrompt = `[기반 뉴스]
헤드라인: ${news.headline}
요약: ${news.summary}
카테고리: ${news.category} / 신호: ${news.signal}
출처: ${news.source}
원문 URL: ${news.url}

[대상 사업부]
${businessUnits.join(", ")}

[사업부 컨텍스트]
${buContextLines.join("\n\n")}

[작성 지시]
위 뉴스가 대상 사업부에 미치는 기회·위협을 1페이지 리포트로 작성하세요. 사업부 컨텍스트의 KPI·경쟁사를 본문에 반드시 활용하세요.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: REPORT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildReportHtml(report, news, businessUnits) {
  const sectionLabels = {
    signal: { name: "핵심 신호", color: "#1a1a1a" },
    opportunity: { name: "당사 기회 (Opportunity)", color: "#0c447c" },
    threat: { name: "당사 위협 (Threat)", color: "#a32d2d" },
  };

  const now = new Date();
  const dateStr = `'${String(now.getFullYear()).slice(2)}.${
    now.getMonth() + 1
  }.${now.getDate()}`;

  const sectionsHtml = report.sections
    .map((s) => {
      const label = sectionLabels[s.type] || { name: s.type, color: "#1a1a1a" };
      const itemsHtml = (s.items || [])
        .map((it) =>
          it.level === 3
            ? `<p style="margin: 4pt 0 4pt 40pt; font-size: 10.5pt; color: #5f5e5a;">· ${escapeXml(
                it.text
              )}</p>`
            : `<p style="margin: 6pt 0 6pt 20pt; font-size: 11.5pt;">- ${escapeXml(
                it.text
              )}</p>`
        )
        .join("");
      return `
        <div style="margin-top: 16pt;">
          <p style="font-size: 11pt; color: ${
            label.color
          }; margin: 0 0 4pt 0; font-weight: bold;">[${label.name}]</p>
          <p style="font-size: 13pt; margin: 0; font-weight: bold; color: #1a1a1a;">□ ${escapeXml(
            s.headline
          )}</p>
          ${itemsHtml}
        </div>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office'
      xmlns:w='urn:schemas-microsoft-com:office:word'
      xmlns='http://www.w3.org/TR/REC-html40'>
<head>
<meta charset='utf-8'>
<title>DA Market Insight Report</title>
<!--[if gte mso 9]><xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
<w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml><![endif]-->
<style>
@page { size: A4; margin: 2cm 1.8cm; }
body { font-family: '맑은 고딕', 'Malgun Gothic', sans-serif; font-size: 11pt; line-height: 1.6; color: #1a1a1a; }
h1 { font-size: 20pt; margin: 0 0 4pt 0; }
.subtitle { font-size: 12pt; color: #5f5e5a; margin: 0 0 4pt 0; }
.meta { font-size: 9.5pt; color: #888780; margin: 0 0 14pt 0; padding-bottom: 8pt; border-bottom: 0.5pt solid #d3d1c7; }
.implication { margin-top: 22pt; padding: 10pt 14pt; background: #f1efe8; border-left: 3pt solid #1a1a1a; font-size: 11.5pt; }
.references { margin-top: 24pt; padding-top: 8pt; border-top: 0.5pt solid #d3d1c7; font-size: 9.5pt; color: #5f5e5a; }
</style>
</head>
<body>

<h1>DA Market Insight - 사업부 영향 리포트</h1>
<p class="subtitle">${escapeXml(report.subtitle || news.headline)}</p>
<p class="meta">${dateStr} 발행 · 대상 사업부: ${escapeXml(
    businessUnits.join(" / ")
  )} · 기반 뉴스 신호: ${escapeXml(news.signal)}</p>

${sectionsHtml}

<div class="implication">
<p style="margin: 0 0 4pt 0; font-size: 10pt; color: #5f5e5a;"><strong>마무리 시사점</strong></p>
<p style="margin: 0; font-size: 11.5pt;">${escapeXml(report.implication)}</p>
</div>

<div class="references">
<p style="margin: 0 0 4pt 0;"><strong>※ 참고자료</strong></p>
<p style="margin: 0;">1. ${escapeXml(news.headline)} - ${escapeXml(
    news.url
  )}</p>
</div>

</body>
</html>`;
}

function downloadDocx(html, filename) {
  // html-docx-js 라이브러리가 로드되어 있으면 진짜 OOXML .docx 생성
  if (typeof window.htmlDocx !== "undefined" && window.htmlDocx.asBlob) {
    try {
      const blob = window.htmlDocx.asBlob(html, {
        orientation: "portrait",
        margins: { top: 1134, right: 1020, bottom: 1134, left: 1020 },
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    } catch (err) {
      console.warn("docx 변환 실패, .doc fallback 사용:", err);
    }
  }

  // Fallback: HTML 기반 .doc (데스크탑 Word 전용)
  const blob = new Blob(["\ufeff", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/\.docx$/, ".doc");
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function generateReport() {
  const btn = document.getElementById("generateBtn");
  const checkedBus = Array.from(
    document.querySelectorAll("#buCheckboxGroup input:checked")
  ).map((cb) => cb.value);

  if (checkedBus.length === 0) {
    showToast("사업부를 1개 이상 선택해 주세요", false);
    return;
  }

  let apiKey = getApiKey();
  if (!apiKey) {
    apiKey = promptForApiKey();
    if (!apiKey) return;
  }

  btn.disabled = true;
  btn.classList.add("btn--loading");
  btn.querySelector("i").className = "ti ti-loader-2";
  btn.querySelector("span").textContent = "생성 중... (15초)";

  try {
    const news = state.selectedNews;
    const report = await callClaudeForReport(apiKey, news, checkedBus);

    if (
      !report.sections ||
      !Array.isArray(report.sections) ||
      report.sections.length === 0
    ) {
      throw new Error("리포트 구조 검증 실패");
    }

    const html = buildReportHtml(report, news, checkedBus);
    const safeBus = checkedBus.join("_").replace(/[^가-힣A-Za-z0-9_]/g, "");
    const ts = new Date().toISOString().slice(0, 10);
    const filename = `DA_Insight_${ts}_${safeBus}.docx`;
    downloadDocx(html, filename);

    closeReportModal();
    showToast(`${checkedBus.length}개 사업부 리포트 다운로드 完了`, true);
  } catch (err) {
    console.error("리포트 생성 실패:", err);
    const msg = err.message || String(err);
    if (
      msg.includes("401") ||
      msg.includes("authentication_error") ||
      msg.includes("invalid x-api-key")
    ) {
      clearApiKey();
      showToast("API 키 인증 실패. 다시 입력해 주세요.", false);
    } else if (msg.includes("429") || msg.includes("rate_limit")) {
      showToast("API 호출 한도 초과. 잠시 後 다시 시도해 주세요.", false);
    } else if (msg.includes("credit") || msg.includes("billing")) {
      showToast("API 잔액 부족. 콘솔에서 충전해 주세요.", false);
    } else {
      showToast(`리포트 생성 실패: ${msg.slice(0, 60)}`, false);
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove("btn--loading");
    btn.querySelector("i").className = "ti ti-file-text";
    btn.querySelector("span").textContent = "리포트 생성";
  }
}

function showToast(message, success = true) {
  const toast = document.getElementById("toast");
  document.getElementById("toastMessage").textContent = message;
  toast.querySelector("i").className = success
    ? "ti ti-circle-check"
    : "ti ti-alert-circle";
  toast.hidden = false;
  setTimeout(() => {
    toast.hidden = true;
  }, 2800);
}

// ===== Event bindings =====
function bindEvents() {
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    renderNewsGrid();
  });

  document.getElementById("filterBu").addEventListener("change", (e) => {
    state.bu = e.target.value;
    renderNewsGrid();
  });

  document.getElementById("filterPeriod").addEventListener("change", (e) => {
    state.period = Number(e.target.value);
    renderStats();
    renderCategoryTabs();
    renderNewsGrid();
  });

  // Modal close handlers
  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", closeReportModal);
  });

  document.getElementById("generateBtn").addEventListener("click", generateReport);

  // Checkbox visual update (for :has fallback)
  document.querySelectorAll("#buCheckboxGroup input").forEach((cb) => {
    cb.addEventListener("change", () => {
      // CSS :has handles styling; no JS needed in modern browsers
    });
  });

  // ESC closes modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("reportModal").hidden) {
      closeReportModal();
    }
  });
}

// ===== Data loader =====
async function loadNewsData() {
  try {
    const res = await fetch("data/news.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    NEWS_DATA = json.items || [];
    NEWS_UPDATED_AT = json.updatedAt;
  } catch (err) {
    console.error("news.json 로드 실패:", err);
    NEWS_DATA = [];
    showToast("뉴스 데이터 로드 실패", false);
  }
}

function formatUpdatedAt(isoString) {
  if (!isoString) return formatLastUpdated();
  const d = new Date(isoString);
  const yy = String(d.getFullYear()).slice(2);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `'${yy}.${m}.${day} ${hh}:${mm} 갱신`;
}

// ===== Init =====
async function init() {
  await Promise.all([loadNewsData(), loadConfig()]);
  document.querySelector("#lastUpdated span").textContent = formatUpdatedAt(
    NEWS_UPDATED_AT
  );
  renderStats();
  renderCategoryTabs();
  renderNewsGrid();
  bindEvents();
}

document.addEventListener("DOMContentLoaded", init);
