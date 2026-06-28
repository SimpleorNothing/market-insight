/**
 * DA Market Insight v2
 *
 * - 신호 렌즈 + 액션 등급 + 영향도 점수
 * - 렌즈(단일) + 경쟁사(다중) + 제품(다중) 3행 필터
 * - 정렬·그룹·뷰 토글
 * - Claude API 직접 호출 → docx 자동 다운로드
 */

// ===== State =====
const LENSES = ["전체", "소비자", "기술", "경쟁사", "정책", "거시"];
const PRODUCTS = [];
const COMPETITORS = [];

// 조회기간 프리셋 (days: null = 전체)
const PERIODS = [
  { label: "전체", days: null },
  { label: "1일", days: 1 },
  { label: "1주", days: 7 },
  { label: "1개월", days: 30 },
];

// 렌즈別 활성/비활성 규칙
const LENS_ACTIVATION = {
  전체:    { product: true,  competitor: true },
  소비자:  { product: true,  competitor: false },
  기술:    { product: true,  competitor: false },
  경쟁사:  { product: true,  competitor: true },
  정책:    { product: false, competitor: false },
  거시:    { product: false, competitor: false },
};

const GRADE_ORDER = ["긴급", "주요", "주시", "참고"];
const LENS_ORDER = ["소비자", "기술", "경쟁사", "정책", "거시"];

const GRADE_MEANING = {
  긴급: "즉시 경영진 보고",
  주요: "주간 정기 보고",
  주시: "모니터링 지속",
  참고: "백그라운드 적재",
};

const GRADE_CLASS = {
  긴급: "urgent",
  주요: "major",
  주시: "watch",
  참고: "ref",
};

let NEWS_DATA = [];
let NEWS_UPDATED_AT = null;
let CONFIG = null;

const state = {
  lens: "전체",
  lensGroup: null, // 상단 KPI 카드 (null=전체 / "소비자" / "경쟁사" / "기타")
  period: 1,
  dateFrom: null,
  dateTo: null,
  keyword: "",
  products: new Set(),
  competitors: new Set(),
  tag: null,
  sort: "latest",
  group: "competitor",
  view: "card",
  selectedNews: null,
};

// ===== Utilities =====
function timeAgo(isoString) {
  const now = new Date();
  const then = new Date(isoString);
  const diffMin = Math.floor((now - then) / 60000);
  if (diffMin < 60) return `${diffMin}분 前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}일 前`;
  return then.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function formatUpdatedAt(isoString) {
  const d = isoString ? new Date(isoString) : new Date();
  const yyyy = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}.${m}.${day} ${hh}:${mm} 갱신`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeXml(s) {
  return escapeHtml(s);
}

// ===== Data loaders =====
async function loadConfig() {
  try {
    const res = await fetch("scripts/config.json", { cache: "no-cache" });
    CONFIG = await res.json();
    PRODUCTS.splice(0, PRODUCTS.length, ...(CONFIG.products || []));
    COMPETITORS.splice(0, COMPETITORS.length, ...(CONFIG.competitors || []));
  } catch (err) {
    console.error("config.json 로드 실패:", err);
    CONFIG = { products: [], competitors: [], productContext: {}, gradeMeaning: GRADE_MEANING };
  }
}

async function loadNewsData() {
  try {
    const res = await fetch("data/news.json", { cache: "no-cache" });
    const json = await res.json();
    NEWS_DATA = (json.items || []).filter((n) => n.lens && n.grade);
    NEWS_UPDATED_AT = json.updatedAt;
  } catch (err) {
    console.error("news.json 로드 실패:", err);
    NEWS_DATA = [];
  }
}

// ===== Filter logic =====
function getFilteredNews(opts = {}) {
  return NEWS_DATA.filter((n) => {
    // 조회기간 필터 — 직접 지정 범위 우선, 없으면 프리셋
    if (state.dateFrom || state.dateTo) {
      const t = new Date(n.publishedAt).getTime();
      if (state.dateFrom && t < new Date(state.dateFrom + "T00:00:00").getTime()) return false;
      if (state.dateTo && t > new Date(state.dateTo + "T23:59:59.999").getTime()) return false;
    } else if (state.period) {
      const cutoff = Date.now() - state.period * 24 * 60 * 60 * 1000;
      if (new Date(n.publishedAt).getTime() < cutoff) return false;
    }

    // ignoreFilters: 렌즈·경쟁사·제품 필터 무시 (KPI 집계용)
    if (opts.ignoreFilters) return true;

    // 키워드 검색 (제목·요약·태그·경쟁사·제품)
    if (state.keyword) {
      const hay = [
        n.headline,
        n.summary,
        ...(n.tags || []),
        ...(n.competitors || []),
        ...(n.products || []),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(state.keyword)) return false;
    }

    // 키워드 태그 필터 (카드 하단 # 클릭)
    if (state.tag) {
      const haystack = [
        ...(n.competitors || []),
        ...(n.products || []),
        ...(n.tags || []),
      ];
      if (!haystack.includes(state.tag)) return false;
    }

    // 렌즈 필터
    if (state.lens !== "전체" && n.lens !== state.lens) return false;

    // 상단 KPI 카드(렌즈 그룹) 필터 — 기타 = 소비자·경쟁사 外 렌즈
    if (state.lensGroup === "소비자" && n.lens !== "소비자") return false;
    if (state.lensGroup === "경쟁사" && n.lens !== "경쟁사") return false;
    if (state.lensGroup === "기타" && (n.lens === "소비자" || n.lens === "경쟁사")) return false;

    // 제품 필터 (다중, OR)
    if (state.products.size > 0) {
      const match = (n.products || []).some((p) => state.products.has(p));
      if (!match) return false;
    }

    // 경쟁사 필터 (다중, OR)
    if (state.competitors.size > 0) {
      const match = (n.competitors || []).some((c) => state.competitors.has(c));
      if (!match) return false;
    }

    return true;
  });
}

function getSortedNews(items) {
  const sorted = [...items];
  if (state.sort === "latest") {
    sorted.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  } else if (state.sort === "impact") {
    sorted.sort((a, b) => (b.impact || 0) - (a.impact || 0));
  } else {
    // relevance: 활성 필터 매칭 정도
    sorted.sort((a, b) => {
      const scoreA = relevanceScore(a);
      const scoreB = relevanceScore(b);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    });
  }
  return sorted;
}

function relevanceScore(n) {
  let s = 0;
  if (state.lens !== "전체" && n.lens === state.lens) s += 2;
  state.products.forEach((p) => {
    if ((n.products || []).includes(p)) s += 1;
  });
  state.competitors.forEach((c) => {
    if ((n.competitors || []).includes(c)) s += 1;
  });
  return s;
}

// ===== Rendering =====
function renderHeader() {
  document.getElementById("updatedAtText").textContent = formatUpdatedAt(NEWS_UPDATED_AT);
}

function renderStats() {
  try {
    // KPI는 렌즈·경쟁사·제품 필터 무시, 기간만 반영
    const all = getFilteredNews({ ignoreFilters: true });
    const setText = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };

    const consumer = all.filter((n) => n.lens === "소비자").length;
    const competitor = all.filter((n) => n.lens === "경쟁사").length;
    const other = all.length - consumer - competitor; // 기술·정책·거시 等

    setText("statTotal", all.length);
    setText("statConsumer", consumer);
    setText("statCompetitorLens", competitor);
    setText("statOther", other);

    updateStatSelection();
  } catch (e) {
    console.error("renderStats 오류:", e);
  }
}

function updateStatSelection() {
  document.querySelectorAll(".stat-card[data-lensgroup]").forEach((card) => {
    const group = card.dataset.lensgroup || null; // 전체 카드 = "" → null
    const active = group === state.lensGroup;
    card.classList.toggle("is-selected", active);
    card.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function renderPeriodChips() {
  const container = document.getElementById("periodChips");
  container.innerHTML = "";
  const customActive = !!(state.dateFrom || state.dateTo);
  PERIODS.forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "chip";
    const active = !customActive && state.period === p.days;
    if (active) btn.classList.add("chip--active");
    btn.textContent = p.label;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", active ? "true" : "false");
    btn.addEventListener("click", () => {
      state.period = p.days;
      state.dateFrom = null;
      state.dateTo = null;
      document.getElementById("dateFrom").value = "";
      document.getElementById("dateTo").value = "";
      renderPeriodChips();
      renderResult();
    });
    container.appendChild(btn);
  });
}

function renderLensChips() {
  const container = document.getElementById("lensChips");
  container.innerHTML = "";
  LENSES.forEach((lens) => {
    const btn = document.createElement("button");
    btn.className = "chip";
    if (state.lens === lens) btn.classList.add("chip--active");
    btn.textContent = lens;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", state.lens === lens ? "true" : "false");
    btn.addEventListener("click", () => {
      state.lens = lens;
      // 렌즈 칩과 상단 KPI 카드는 충돌하므로 카드 선택 해제
      state.lensGroup = null;
      // 비활성 행의 선택 초기화하지 않고 유지 (사용자 의도 보존)
      renderLensChips();
      renderFilterRowsState();
      renderResult();
    });
    container.appendChild(btn);
  });
}

function renderProductChips() {
  const container = document.getElementById("productChips");
  container.innerHTML = "";
  PRODUCTS.forEach((p) => {
    const btn = document.createElement("button");
    btn.className = "chip";
    if (state.products.has(p)) btn.classList.add("chip--active");
    btn.textContent = p;
    btn.addEventListener("click", () => {
      if (state.products.has(p)) state.products.delete(p);
      else state.products.add(p);
      renderProductChips();
      updateProductCount();
      renderResult();
    });
    container.appendChild(btn);
  });
  updateProductCount();
}

function renderCompetitorChips() {
  const container = document.getElementById("competitorChips");
  container.innerHTML = "";
  COMPETITORS.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "chip";
    if (state.competitors.has(c)) btn.classList.add("chip--active");
    btn.textContent = c;
    btn.addEventListener("click", () => {
      if (state.competitors.has(c)) state.competitors.delete(c);
      else state.competitors.add(c);
      renderCompetitorChips();
      updateCompetitorCount();
      renderResult();
    });
    container.appendChild(btn);
  });
  updateCompetitorCount();
}

function updateProductCount() {
  document.getElementById("productCount").textContent = state.products.size;
}

function updateCompetitorCount() {
  document.getElementById("competitorCount").textContent = state.competitors.size;
}

function renderFilterRowsState() {
  const rule = LENS_ACTIVATION[state.lens] || { product: true, competitor: true };
  const productRow = document.getElementById("productRow");
  const competitorRow = document.getElementById("competitorRow");

  productRow.classList.toggle("is-disabled", !rule.product);
  competitorRow.classList.toggle("is-disabled", !rule.competitor);

  // 컨텍스트 안내 배너
  const banner = document.getElementById("filterHintBanner");
  if (state.lens === "소비자" || state.lens === "기술") {
    banner.innerHTML = `<i class="ti ti-info-circle" aria-hidden="true"></i>${state.lens} 렌즈에서는 경쟁사 필터가 적용되지 않습니다. 산업 전반 시그널만 노출됩니다.`;
    banner.hidden = false;
  } else if (state.lens === "정책" || state.lens === "거시") {
    banner.innerHTML = `<i class="ti ti-info-circle" aria-hidden="true"></i>${state.lens} 렌즈에서는 제품·경쟁사 필터가 적용되지 않습니다. 거시·규제 시그널만 노출됩니다.`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function renderResult() {
  renderStats();
  const filtered = getFilteredNews();
  document.getElementById("resultCount").textContent = filtered.length;
  updateTagFilterChip();

  const empty = document.getElementById("emptyState");
  const area = document.getElementById("resultArea");

  if (filtered.length === 0) {
    area.innerHTML = "";
    area.hidden = true;
    empty.hidden = false;
    document.getElementById("emptyMessage").textContent =
      NEWS_DATA.length === 0
        ? "데이터 갱신 中입니다. 첫 데이터는 1시간 內 채워집니다."
        : "조건에 맞는 뉴스가 없습니다.";
    return;
  }

  area.hidden = false;
  empty.hidden = true;

  const sorted = getSortedNews(filtered);
  const groups = makeGroups(sorted);

  area.className = state.view === "list" ? "result-area is-list" : "result-area";
  area.innerHTML = groups.map(renderGroup).join("");

  area.querySelectorAll("[data-report-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = Number(e.currentTarget.dataset.reportId);
      openReportModal(id);
    });
  });

  area.querySelectorAll(".tag[data-tag]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      setTagFilter(e.currentTarget.dataset.tag);
    });
  });
}

// ===== Tag filters =====
function setTagFilter(tag) {
  state.tag = state.tag === tag ? null : tag;
  renderResult();
}

function clearTagFilter() {
  state.tag = null;
  renderResult();
}

function updateTagFilterChip() {
  const chip = document.getElementById("tagFilterClear");
  if (state.tag) {
    document.getElementById("tagFilterLabel").textContent = `#${state.tag}`;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}

function makeGroups(items) {
  if (state.group === "none") {
    return [{ key: "", items }];
  }
  const map = new Map();

  if (state.group === "grade") {
    GRADE_ORDER.forEach((g) => map.set(g, []));
    items.forEach((n) => map.get(n.grade)?.push(n));
  } else if (state.group === "lens") {
    LENS_ORDER.forEach((l) => map.set(l, []));
    items.forEach((n) => map.get(n.lens)?.push(n));
  } else if (state.group === "product") {
    PRODUCTS.forEach((p) => map.set(p, []));
    map.set("제품 미분류", []);
    items.forEach((n) => {
      if (!n.products || n.products.length === 0) {
        map.get("제품 미분류").push(n);
      } else {
        n.products.forEach((p) => map.get(p)?.push(n));
      }
    });
  } else if (state.group === "competitor") {
    COMPETITORS.forEach((c) => map.set(c, []));
    map.set("경쟁사 미분류", []);
    items.forEach((n) => {
      if (!n.competitors || n.competitors.length === 0) {
        map.get("경쟁사 미분류").push(n);
      } else {
        n.competitors.forEach((c) => map.get(c)?.push(n));
      }
    });
  }

  const result = Array.from(map.entries())
    .filter(([_, arr]) => arr.length > 0)
    .map(([key, arr]) => ({ key, items: arr }));

  // 모든 그룹을 기사수 내림차순 정렬, '경쟁사 미분류'는 항상 마지막
  result.sort((a, b) => {
    if (a.key === "경쟁사 미분류") return 1;
    if (b.key === "경쟁사 미분류") return -1;
    return b.items.length - a.items.length;
  });

  return result;
}

function renderGroup(group) {
  if (!group.key) {
    return `<div class="group-section">${group.items.map(renderCard).join("")}</div>`;
  }

  let badgeClass = "";
  let meaning = "";

  if (GRADE_ORDER.includes(group.key)) {
    badgeClass = `group-header__badge--${GRADE_CLASS[group.key]}`;
    meaning = GRADE_MEANING[group.key];
  } else if (LENS_ORDER.includes(group.key)) {
    badgeClass = `group-header__badge--lens-${group.key}`;
  }

  return `
    <div class="group-section">
      <div class="group-header">
        <span class="group-header__badge ${badgeClass}">${escapeHtml(group.key)}</span>
        <span class="group-header__count">${group.items.length}건</span>
        ${meaning ? `<span class="group-header__meaning">· ${escapeHtml(meaning)}</span>` : ""}
      </div>
      ${group.items.map(renderCard).join("")}
    </div>
  `;
}

function renderCard(n) {
  const gradeCls = GRADE_CLASS[n.grade] || "ref";
  const sourceName = n.source?.name || "Unknown";
  const sourceUrl = n.source?.url || n.url || "#";
  const tags = (n.tags || []).slice(0, 4);
  const products = n.products || [];
  const competitors = n.competitors || [];

  // 태그 = 경쟁사·제품·자유태그 합쳐 최대 4개
  const allTags = [...competitors, ...products, ...tags].slice(0, 4);

  return `
    <article class="news-card news-card--${gradeCls}">
      <div class="news-card__top">
        <div class="news-card__top-left">
          <span class="lens-badge lens-badge--${n.lens}">${escapeHtml(n.lens)}</span>
          <span class="news-card__meta">
            ${timeAgo(n.publishedAt)} · <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceName)}</a>
          </span>
        </div>
      </div>
      <h3 class="news-card__headline">
        <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.headline)}</a>
      </h3>
      <p class="news-card__summary">${escapeHtml(n.summary)}</p>
      <div class="news-card__bottom">
        <div class="news-card__tags">
          ${allTags
            .map(
              (t) =>
                `<button type="button" class="tag${state.tag === t ? " is-active" : ""}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`
            )
            .join("")}
        </div>
        <div class="news-card__actions">
          <button class="news-card__action news-card__action--report" data-report-id="${n.id}">
            <i class="ti ti-file-text" aria-hidden="true"></i>
            <span>리포트 생성</span>
          </button>
        </div>
      </div>
    </article>
  `;
}

// ===== Report generation =====
const REPORT_SYSTEM_PROMPT = `당신은 'Herald'입니다. 가전 산업 시장 동향 뉴스 기반 사업부 영향 1페이지 리포트 작성 전문가입니다.

【출력 형식 — 절대 규칙】
- 응답은 반드시 순수 JSON 객체 1개만 출력
- 코드펜스, 주석, 추가 설명 일체 금지
- 거절 응답·영문 회피 응답 일체 금지

【리포트 구조】
- '핵심 신호(signal)' 섹션을 항상 첫 섹션으로 포함.
- 그 외 섹션은 [요청 분석 관점]에 명시된 섹션 type만, 명시된 순서대로 출력.
- 요청되지 않은 섹션 type은 절대 출력 금지.
- 각 섹션 items는 1~2개. 요청 섹션이 많을수록 더 간결히 (전체 A4 1~2페이지 內).

【섹션 type 정의】
- signal: 뉴스 사실 요약 (항상 포함)
- opportunity: 선택 제품에 미치는 기회
- threat: 선택 제품에 미치는 위협
- timeaxis: 영향 시점·강도. 각 item 머리에 '0~6個月 / 6~18個月 / 18個月~' 구간 명시
- valuechain: R&D·공급망·생산·채널·서비스 中 타격 지점을 머리에 명시
- positioning: 당사 vs 경쟁사의 점유율·프리미엄·기술 軸 이동 방향

【작성 규칙】
- 헤드라인 30자 이내, 결론 + 수치, 기호·번호 없이 본문만
- 각 섹션 items는 1~2개로 제한 (요청 섹션 수에 맞춰 간결히)
- 첫머리 연결어 (우선/그 결과/한편/이에 따라/종합하면/가장 먼저)
- L2 본문은 28~36자 內外, 정량 수치 1개 以上 권장
- '당사' 호칭 통일 (자사 금지)
- 한자 약어 가능 (時·可·後·內·等)
- 모호 표현 금지 (필요·검토·강화)
- 각 섹션은 가능하면 선택 제품의 KPI·경쟁사를 1개 以上 참조
- 마무리 시사점: '당사' 주어 시작, 액션 동사 종결, 2문장 이내

【출력 스키마】
{
  "subtitle": "뉴스 핵심 한 줄 (15자 이내)",
  "sections": [
    {
      "type": "signal | opportunity | threat | timeaxis | valuechain | positioning",
      "headline": "헤드라인 (기호 없이 본문만)",
      "items": [{"level": 2, "text": "L2 본문"}]
    }
  ],
  "implication": "마무리 시사점"
}

sections 배열은 [요청 분석 관점] 순서를 그대로 따른다. JSON 외 어떤 텍스트도 출력 금지.`;

// 분석 관점 메타데이터: id → 라벨 / 산출 섹션 type / 프롬프트 지시
const ANALYSIS_PERSPECTIVES = {
  opp_threat: {
    label: "기회·위협 2축 분석",
    sections: ["opportunity", "threat"],
    instruct: "선택 제품에 미치는 기회(opportunity)와 위협(threat)을 2축으로 분해.",
  },
  timeaxis: {
    label: "시간축 임팩트",
    sections: ["timeaxis"],
    instruct: "영향을 0~6個月 / 6~18個月 / 18個月~ 구간으로 나눠 시점·강도를 제시.",
  },
  valuechain: {
    label: "밸류체인 타격점",
    sections: ["valuechain"],
    instruct: "R&D·공급망·생산·채널·서비스 中 어디에 영향이 집중되는지 타격 지점을 명시.",
  },
  positioning: {
    label: "경쟁 포지셔닝 변화",
    sections: ["positioning"],
    instruct: "당사 vs 관련 경쟁사의 점유율·프리미엄·기술 軸 상대 위치 이동 방향을 진단.",
  },
};
const ANALYSIS_ORDER = ["opp_threat", "timeaxis", "valuechain", "positioning"];

// 공용 충전 키 프록시(Cloudflare Worker) 주소. 설정돼 있으면 사용자별 키 입력 없이 이 프록시로 호출.
function getReportProxyUrl() {
  const url = CONFIG?.reportProxyUrl;
  return typeof url === "string" && url.trim() ? url.trim() : null;
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

async function callClaudeForReport(apiKey, news, products, perspectives) {
  const ctx = CONFIG?.productContext || {};
  const buContextLines = products.map((p) => {
    const c = ctx[p] || {};
    return (
      `${p}:\n` +
      `  주요 제품: ${(c.keywords || []).slice(0, 6).join(", ") || "(미등록)"}\n` +
      `  주요 경쟁사: ${(c.majorCompetitors || []).join(", ") || "(미등록)"}\n` +
      `  핵심 KPI: ${(c.kpis || []).join(", ") || "(미등록)"}`
    );
  });

  const selected = (perspectives && perspectives.length ? perspectives : ["opp_threat"])
    .filter((p) => ANALYSIS_PERSPECTIVES[p]);
  const ordered = ANALYSIS_ORDER.filter((p) => selected.includes(p));
  const requestedSections = ["signal"].concat(
    ordered.flatMap((p) => ANALYSIS_PERSPECTIVES[p].sections)
  );
  const perspectiveLines = ordered
    .map((p) => `· ${ANALYSIS_PERSPECTIVES[p].label}: ${ANALYSIS_PERSPECTIVES[p].instruct}`)
    .join("\n");

  const userPrompt = `[기반 뉴스]
헤드라인: ${news.headline}
요약: ${news.summary}
렌즈: ${news.lens} / 등급: ${news.grade} (영향도 ${news.impact})
관련 제품: ${(news.products || []).join(", ") || "(없음)"}
관련 경쟁사: ${(news.competitors || []).join(", ") || "(없음)"}
출처: ${news.source?.name || ""}
원문 URL: ${news.url}

[대상 제품 (분석 범위)]
${products.join(", ")}

[제품 컨텍스트]
${buContextLines.join("\n\n")}

[요청 분석 관점 — sections를 이 순서로 출력]
${requestedSections.join(" → ")}

[관점별 작성 지시]
${perspectiveLines}

[작성 지시]
위 뉴스가 대상 제품에 미치는 영향을 요청 분석 관점에 따라 작성하세요. 제품 컨텍스트의 KPI·경쟁사를 본문에 반드시 활용하세요.`;

  const body = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    system: REPORT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const proxyUrl = getReportProxyUrl();
  let res;
  if (proxyUrl) {
    // 공용 충전 키 사용: 키는 프록시(Worker)가 보관하므로 브라우저에서 전송하지 않음
    res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } else {
    // 폴백: 사용자별 키로 Anthropic API 직접 호출
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body,
    });
  }

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

// ===== 네이티브 OOXML(.docx) 생성 =====
// html-docx-js는 HTML을 w:altChunk(대체 콘텐츠)로 감싼 docx를 만든다.
// 데스크톱 Word는 이를 풀어 열지만 모바일/웹 Word는 altChunk 미지원 →
// "대체 형식이 포함된 파일을 열 수 없습니다" 오류 발생.
// 따라서 구조화된 report 데이터로 진짜 WordprocessingML 문서를 직접 만든다.

// OOXML 본문 텍스트 이스케이프 (& < > 만, 따옴표는 본문에서 불필요)
function docxEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 한 개의 텍스트 런(run). pt 단위 글꼴 크기 → 하프포인트(×2).
function docxRun(text, { bold = false, color = "1a1a1a", pt = 10.5 } = {}) {
  const sz = Math.round(pt * 2);
  const rPr =
    `<w:rPr>` +
    (bold ? `<w:b/><w:bCs/>` : ``) +
    `<w:color w:val="${color}"/>` +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` +
    `<w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="Malgun Gothic" w:cs="Malgun Gothic"/>` +
    `</w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${docxEsc(text)}</w:t></w:r>`;
}

// 한 개의 문단(paragraph). spacing/indent는 twips(1pt=20), 들여쓰기는 인자 그대로.
function docxPara(runsXml, { beforePt = 0, afterPt = 2, indentTwips = 0, hangingTwips = 0, shade = null, border = null } = {}) {
  let pPr = `<w:pPr><w:spacing w:before="${Math.round(beforePt * 20)}" w:after="${Math.round(afterPt * 20)}" w:line="276" w:lineRule="auto"/>`;
  if (indentTwips || hangingTwips) pPr += `<w:ind w:left="${indentTwips}"${hangingTwips ? ` w:hanging="${hangingTwips}"` : ""}/>`;
  if (shade) pPr += `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>`;
  if (border) pPr += `<w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="1a1a1a"/></w:pBdr>`;
  pPr += `</w:pPr>`;
  return `<w:p>${pPr}${runsXml}</w:p>`;
}

function buildDocxBlob(report, news, products) {
  const sectionLabels = {
    signal: { name: "핵심 신호", color: "1a1a1a" },
    opportunity: { name: "당사 기회", color: "0c447c" },
    threat: { name: "당사 위협", color: "a32d2d" },
    timeaxis: { name: "시간축 임팩트", color: "2a6f4e" },
    valuechain: { name: "밸류체인 타격점", color: "7a4f1d" },
    positioning: { name: "경쟁 포지셔닝 변화", color: "5a3a8a" },
  };

  const now = new Date();
  const dateStr = `'${String(now.getFullYear()).slice(2)}.${now.getMonth() + 1}.${now.getDate()}`;

  const body = [];

  // 제목 / 부제 / 메타
  body.push(docxPara(docxRun("DA Market Insight · 사업부 영향 리포트", { bold: true, pt: 15 }), { afterPt: 1 }));
  body.push(docxPara(docxRun(report.subtitle || news.headline, { color: "5f5e5a", pt: 11 }), { afterPt: 2 }));
  body.push(
    docxPara(
      docxRun(
        `${dateStr} 발행 · 대상 제품: ${products.join(" / ")} · 등급: ${news.grade} · 영향도 ${(news.impact || 0).toFixed(1)}`,
        { color: "888780", pt: 8.5 }
      ),
      { afterPt: 6 }
    )
  );

  // 섹션 (핵심 신호 / 당사 기회 / 당사 위협)
  (report.sections || []).forEach((s) => {
    const label = sectionLabels[s.type] || { name: s.type, color: "1a1a1a" };
    const headline = String(s.headline || "")
      .replace(/^[\s□■▪◆·.\-]+/, "")
      .trim();
    const headRuns =
      docxRun(`[${label.name}]`, { bold: true, color: label.color, pt: 11 }) +
      docxRun("  ", { bold: true, pt: 11 }) +
      docxRun(headline, { bold: true, color: "1a1a1a", pt: 11 });
    body.push(docxPara(headRuns, { beforePt: 9, afterPt: 2 }));
    (s.items || []).forEach((it) => {
      // 행잉 인덴트 불릿: 첫 줄 '•' 後 탭, 둘째 줄부터 본문에 맞춰 정렬
      const bulletRuns =
        docxRun("•", { pt: 10, color: "5f5e5a" }) +
        `<w:r><w:tab/></w:r>` +
        docxRun(it.text, { pt: 10 });
      body.push(docxPara(bulletRuns, { beforePt: 1, afterPt: 1, indentTwips: 600, hangingTwips: 280 }));
    });
  });

  // 마무리 시사점 (음영 + 좌측 굵은 테두리)
  body.push(
    docxPara(docxRun("마무리 시사점", { bold: true, color: "5f5e5a", pt: 9 }), {
      beforePt: 11,
      afterPt: 1,
      shade: "f1efe8",
      border: true,
      indentTwips: 120,
    })
  );
  body.push(
    docxPara(docxRun(report.implication, { pt: 10.5 }), {
      afterPt: 2,
      shade: "f1efe8",
      border: true,
      indentTwips: 120,
    })
  );

  // 참고자료
  body.push(docxPara(docxRun("※ 참고자료", { bold: true, color: "5f5e5a", pt: 8.5 }), { beforePt: 10, afterPt: 1 }));
  body.push(
    docxPara(docxRun(`1. ${news.headline} - ${news.url}`, { color: "5f5e5a", pt: 8.5 }), { afterPt: 0 })
  );

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join("")}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="794" w:right="850" w:bottom="794" w:left="850" w:header="708" w:footer="708" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  return zipStore([
    { name: "[Content_Types].xml", text: contentTypes },
    { name: "_rels/.rels", text: rels },
    { name: "word/document.xml", text: documentXml },
  ]);
}

// ===== 최소 ZIP(STORE, 무압축) 라이터 =====
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: enc.encode(f.text) }));

  const localParts = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  entries.forEach((e) => {
    const crc = crc32(e.data);
    const size = e.data.length;
    const nameLen = e.name.length;

    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), // mod time/date
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameLen), ...u16(0),
    ];
    localParts.push(new Uint8Array(local), e.name, e.data);

    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameLen), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset),
    ]);

    offset += local.length + nameLen + size;
  });

  const centralChunks = [];
  let centralSize = 0;
  central.forEach((c, i) => {
    const header = new Uint8Array(c);
    centralChunks.push(header, entries[i].name);
    centralSize += header.length + entries[i].name.length;
  });

  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);

  return new Blob([...localParts, ...centralChunks, eocd], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


// ===== Modal =====

// 예상 생성 시간 가중치(초): 기본 + 분석관점/대상제품 가산
const EST_BASE = 8, EST_PERSP = 14, EST_ALL = 16, EST_ITEM = 5;
const EST_MAX = EST_BASE + 4 * EST_PERSP + EST_ALL; // 풀스케일 80초

function estimateSeconds(products, perspectives) {
  const totalProducts = (typeof PRODUCTS !== "undefined" ? PRODUCTS.length : 0);
  const allOn = totalProducts > 0 && products.length === totalProducts;
  const prodT = allOn ? EST_ALL : products.length * EST_ITEM;
  return EST_BASE + perspectives.length * EST_PERSP + prodT;
}
function fmtEstimate(s) {
  if (s < 60) return `약 ${s}초`;
  const m = Math.floor(s / 60), sec = s % 60;
  return `약 ${m}분${sec ? ` ${sec}초` : ""}`;
}
function estimateLabel(products, perspectives) {
  return fmtEstimate(estimateSeconds(products, perspectives));
}
function updateReportEstimate() {
  const valueEl = document.getElementById("estimateValue");
  if (!valueEl) return;
  const products = Array.from(
    document.querySelectorAll("#productCheckboxGroup input:checked")
  ).map((cb) => cb.value);
  const perspectives = Array.from(
    document.querySelectorAll("#analysisCheckboxGroup input:checked")
  ).map((cb) => cb.value);

  const totalProducts = (typeof PRODUCTS !== "undefined" ? PRODUCTS.length : 0);
  const allOn = totalProducts > 0 && products.length === totalProducts;
  const t = estimateSeconds(products, perspectives);

  const prev = Number(valueEl.dataset.sec || -1);
  valueEl.textContent = fmtEstimate(t);
  valueEl.dataset.sec = String(t);

  const bar = document.getElementById("estimateBar");
  if (bar) bar.style.width = Math.min(100, Math.round((t / EST_MAX) * 100)) + "%";
  const note = document.getElementById("estimateNote");
  if (note) {
    note.textContent =
      `분석 관점 ${perspectives.length}개 · 대상 제품 ${allOn ? "전제품" : products.length + "개"}`;
  }

  if (t > prev && prev >= 0) {
    valueEl.classList.add("is-up");
    setTimeout(() => valueEl.classList.remove("is-up"), 450);
  }
}

function renderProductCheckboxes(preselect = []) {
  const container = document.getElementById("productCheckboxGroup");
  container.innerHTML = "";

  // 맨 앞 '전제품' 토글: 전체 선택/해제. 실제 제품 값에 섞이지 않도록 button 으로 둠.
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "checkbox-item checkbox-item--all";
  allBtn.textContent = "전제품";
  container.appendChild(allBtn);

  PRODUCTS.forEach((p) => {
    const label = document.createElement("label");
    label.className = "checkbox-item";
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(p)}" ${preselect.includes(p) ? "checked" : ""} /><span>${escapeHtml(p)}</span>`;
    container.appendChild(label);
  });

  const boxes = () => Array.from(container.querySelectorAll('input[type="checkbox"]'));
  const syncAllState = () => {
    const all = boxes();
    allBtn.classList.toggle("is-active", all.length > 0 && all.every((cb) => cb.checked));
  };
  allBtn.addEventListener("click", () => {
    const all = boxes();
    const next = !(all.length > 0 && all.every((cb) => cb.checked));
    all.forEach((cb) => { cb.checked = next; });
    syncAllState();
    updateReportEstimate();
  });
  container.addEventListener("change", () => { syncAllState(); updateReportEstimate(); });
  syncAllState();
}

function openReportModal(id) {
  const news = NEWS_DATA.find((n) => n.id === id);
  if (!news) return;
  state.selectedNews = news;

  document.getElementById("modalNewsPreview").innerHTML = `
    <p class="modal__news-preview-label">선택된 뉴스</p>
    <p class="modal__news-preview-headline">${escapeHtml(news.headline)}</p>
  `;

  renderProductCheckboxes(news.products || []);
  updateReportEstimate();

  document.getElementById("reportModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeReportModal() {
  document.getElementById("reportModal").hidden = true;
  document.body.style.overflow = "";
  state.selectedNews = null;
}

async function generateReport() {
  const btn = document.getElementById("generateBtn");
  const checked = Array.from(
    document.querySelectorAll("#productCheckboxGroup input:checked")
  ).map((cb) => cb.value);

  if (checked.length === 0) {
    showToast("제품을 1개 以上 선택해 주세요", false);
    return;
  }

  const perspectives = Array.from(
    document.querySelectorAll("#analysisCheckboxGroup input:checked")
  ).map((cb) => cb.value);

  if (perspectives.length === 0) {
    showToast("분석 관점을 1個 以上 선택해 주세요", false);
    return;
  }

  // 공용 충전 키 프록시가 설정돼 있으면 사용자별 키 입력을 건너뜀
  let apiKey = null;
  if (!getReportProxyUrl()) {
    apiKey = getApiKey();
    if (!apiKey) {
      apiKey = promptForApiKey();
      if (!apiKey) return;
    }
  }

  btn.disabled = true;
  btn.classList.add("btn--loading");
  btn.querySelector("i").className = "ti ti-loader-2";
  btn.querySelector("span").textContent = `생성 中... (${estimateLabel(checked, perspectives)})`;

  try {
    const news = state.selectedNews;
    const report = await callClaudeForReport(apiKey, news, checked, perspectives);

    if (!report.sections || !Array.isArray(report.sections)) {
      throw new Error("리포트 구조 검증 실패");
    }

    const blob = buildDocxBlob(report, news, checked);
    const safe = checked.join("_").replace(/[^가-힣A-Za-z0-9_]/g, "");
    const ts = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `DA_Insight_${ts}_${safe}.docx`);

    closeReportModal();
    showToast(`${checked.length}개 제품 리포트 다운로드 完了`, true);
  } catch (err) {
    console.error(err);
    const msg = err.message || String(err);
    if (msg.includes("401") || msg.includes("authentication") || msg.includes("invalid x-api-key")) {
      if (getReportProxyUrl()) {
        // 공용 키 인증 실패 — 사용자가 아니라 관리자가 키를 점검해야 함
        showToast("공용 키 인증 실패. 관리자에게 문의해 주세요.", false);
      } else {
        clearApiKey();
        showToast("API 키 인증 실패. 다시 입력해 주세요.", false);
      }
    } else if (msg.includes("429") || msg.includes("rate_limit")) {
      showToast("API 호출 한도 초과. 잠시 後 재시도.", false);
    } else if (msg.includes("credit") || msg.includes("billing")) {
      showToast("API 잔액 부족. 콘솔에서 충전.", false);
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
  toast.querySelector("i").className = success ? "ti ti-circle-check" : "ti ti-alert-circle";
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 2800);
}

// ===== Events =====
function bindEvents() {
  document.getElementById("sortSelect").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderResult();
  });
  document.getElementById("groupSelect").addEventListener("change", (e) => {
    state.group = e.target.value;
    renderResult();
  });

  document.getElementById("keywordSearch").addEventListener("input", (e) => {
    state.keyword = e.target.value.trim().toLowerCase();
    renderResult();
  });

  const dateFrom = document.getElementById("dateFrom");
  const dateTo = document.getElementById("dateTo");
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  dateFrom.max = todayStr;
  dateTo.max = todayStr;
  function onDateRangeChange() {
    state.dateFrom = dateFrom.value || null;
    state.dateTo = dateTo.value || null;
    if (state.dateFrom || state.dateTo) state.period = null;
    renderPeriodChips();
    renderResult();
  }
  dateFrom.addEventListener("change", onDateRangeChange);
  dateTo.addEventListener("change", onDateRangeChange);
  document.querySelectorAll(".view-toggle__btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".view-toggle__btn").forEach((x) =>
        x.classList.remove("view-toggle__btn--active")
      );
      b.classList.add("view-toggle__btn--active");
      state.view = b.dataset.view;
      renderResult();
    });
  });
  document.querySelectorAll(".stat-card[data-lensgroup]").forEach((card) => {
    const handler = () => {
      const group = card.dataset.lensgroup || null; // 전체 카드 = "" → null
      // 같은 카드 재클릭 → 전체로 해제 (토글)
      state.lensGroup = state.lensGroup === group ? null : group;
      // 렌즈 칩 필터와 충돌 방지 — 카드 선택 時 렌즈 필터 초기화
      state.lens = "전체";
      renderLensChips();
      renderFilterRowsState();
      renderResult();
    };
    card.addEventListener("click", handler);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    });
  });
  document.getElementById("tagFilterClear").addEventListener("click", clearTagFilter);
  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", closeReportModal);
  });
  document.getElementById("generateBtn").addEventListener("click", generateReport);
  const analysisGroup = document.getElementById("analysisCheckboxGroup");
  if (analysisGroup) {
    analysisGroup.addEventListener("change", updateReportEstimate);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("reportModal").hidden) {
      closeReportModal();
    }
  });
}

// ===== Init =====
async function init() {
  await Promise.all([loadConfig(), loadNewsData()]);
  const steps = [
    renderHeader,
    renderStats,
    renderPeriodChips,
    renderLensChips,
    renderProductChips,
    renderCompetitorChips,
    renderFilterRowsState,
    renderResult,
    bindEvents,
  ];
  for (const fn of steps) {
    try { fn(); } catch (e) { console.error(`init 단계 오류 [${fn.name}]:`, e); }
  }
}

document.addEventListener("DOMContentLoaded", init);
