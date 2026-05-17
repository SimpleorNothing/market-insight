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

function generateReport() {
  const btn = document.getElementById("generateBtn");
  const checkedBus = Array.from(
    document.querySelectorAll('#buCheckboxGroup input:checked')
  ).map((cb) => cb.value);

  if (checkedBus.length === 0) {
    showToast("사업부를 1개 이상 선택해 주세요", false);
    return;
  }

  // TODO: 실제 운영 시 백엔드 API 호출
  // 예) POST /api/reports { newsId, businessUnits, analysisType }
  //     → docx 파일 받아서 다운로드 트리거

  btn.disabled = true;
  btn.classList.add("btn--loading");
  btn.querySelector("i").className = "ti ti-loader-2";
  btn.querySelector("span").textContent = "생성 중...";

  setTimeout(() => {
    btn.disabled = false;
    btn.classList.remove("btn--loading");
    btn.querySelector("i").className = "ti ti-file-text";
    btn.querySelector("span").textContent = "리포트 생성";

    closeReportModal();
    showToast(
      `${checkedBus.length}개 사업부 기회·위협 리포트가 생성되었습니다`,
      true
    );
  }, 1400);
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
  await loadNewsData();
  document.querySelector("#lastUpdated span").textContent = formatUpdatedAt(
    NEWS_UPDATED_AT
  );
  renderStats();
  renderCategoryTabs();
  renderNewsGrid();
  bindEvents();
}

document.addEventListener("DOMContentLoaded", init);
