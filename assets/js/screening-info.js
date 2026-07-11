// DA Market Insight — 기사 스크리닝 기준 안내 팝업
// 푸터의 [기사 스크리닝 기준] 링크 클릭 시 scripts/config.json 을 실시간으로 읽어
// 수집 소스 / 2단계 필터 / 차단·우선통과 키워드를 렌더한다.
// app.js(대용량) 무수정 원칙에 따라 독립 파일로 분리. 스타일·마크업 모두 자체 주입.
(function () {
  "use strict";

  var CONFIG_URL = "scripts/config.json";
  var loaded = null; // config 캐시

  // 표시 전용 키워드 분류 (config 는 flat list 유지 — 여기서만 그룹핑)
  var BLOCK_GROUPS = [
    {
      label: "반도체·부품",
      icon: "ti-cpu",
      keys: [
        "반도체", "파운드리", "웨이퍼", "HBM", "AI칩", "AI 칩", "글래스코어",
        "글래스 코어", "유리기판", "유리 기판", "기판", "나노프리즘", "이미지센서",
        "이미지 센서", "아이소셀", "ISOCELL", "CMOS", "semiconductor", "foundry",
        "Nvidia", "엔비디아", "TSMC", "SK하이닉스", "Anthropic", "앤트로픽",
      ],
    },
    {
      label: "모바일·IT기기",
      icon: "ti-device-mobile",
      keys: [
        "갤럭시", "Galaxy", "스마트폰", "smartphone", "폴더블", "아이폰", "iPhone",
        "태블릿", "노트북", "웨어러블", "스마트워치", "언팩", "Unpacked",
      ],
    },
    {
      label: "영상·디스플레이",
      icon: "ti-device-tv",
      keys: ["TV", "OLED TV", "QLED", "스마트TV", "텔레비전"],
    },
    {
      label: "전장·배터리·통신",
      icon: "ti-car",
      keys: [
        "전장부품", "인포테인먼트", "전기차", "자율주행",
        "2차전지", "이차전지", "LG에너지솔루션", "5G", "6G", "통신사",
      ],
    },
    {
      label: "비(非)가전 계열사",
      icon: "ti-building-factory",
      keys: ["삼성전기", "삼성디스플레이", "삼성SDI", "삼성바이오"],
    },
    {
      label: "금융·증시",
      icon: "ti-chart-line",
      keys: [
        "ETF", "코스피", "코스닥", "환율", "금리 인하", "금리 인상",
        "부동산", "아파트", "분양",
      ],
    },
    {
      label: "정치·사회·기타",
      icon: "ti-news-off",
      keys: [
        "정상회담", "대선", "총선", "탄핵", "사설", "칼럼", "논평", "연예", "드라마",
        "사고", "참사", "재판", "검찰", "기상", "스포츠", "축구", "야구",
      ],
    },
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function chips(list) {
    if (!list || !list.length) return '<span class="scr-empty">-</span>';
    return list
      .map(function (k) {
        return '<span class="scr-chip">' + esc(k) + "</span>";
      })
      .join("");
  }

  function injectStyles() {
    if (document.getElementById("screeningInfoStyles")) return;
    var st = document.createElement("style");
    st.id = "screeningInfoStyles";
    st.textContent = [
      ".page-footer { flex-wrap: wrap; align-items: flex-start; }",
      // 설명 문구 아래 줄, 좌측 정렬 (푸터 아이콘 폭 15px + gap 8px 만큼 들여쓰기)
      ".footer-link-row { flex-basis: 100%; margin-top: 8px; padding-left: 23px; }",
      ".footer-link { background: none; border: 0; padding: 4px 2px; margin: 0;",
      "  font: inherit; font-size: 14px; color: var(--accent, #1428a0); cursor: pointer;",
      "  display: inline-flex; align-items: center; gap: 5px; }",
      ".footer-link span { text-decoration: underline; text-underline-offset: 3px; }",
      ".footer-link:hover { opacity: .75; }",
      "#screeningModal .modal__panel { max-width: 560px; width: 100%;",
      "  max-height: 82vh; display: flex; flex-direction: column; }",
      "#screeningModal .modal__body { overflow-y: auto; }",
      ".scr-flow { display: flex; flex-direction: column; gap: 8px; margin: 0 0 22px; }",
      ".scr-step { display: flex; gap: 10px; padding: 11px 13px; border-radius: 8px;",
      "  background: var(--bg-soft, #f5f6f8); font-size: 14px; line-height: 1.55; }",
      ".scr-step__no { flex-shrink: 0; width: 21px; height: 21px; border-radius: 50%;",
      "  background: var(--accent, #1428a0); color: #fff; font-size: 12px; font-weight: 700;",
      "  display: flex; align-items: center; justify-content: center; margin-top: 1px; }",
      ".scr-step__t { font-weight: 600; display: block; margin-bottom: 2px; }",
      ".scr-step__d { color: var(--text-secondary, #666); }",
      ".scr-sec { margin-bottom: 22px; }",
      ".scr-sec:last-child { margin-bottom: 4px; }",
      ".scr-sec__h { font-size: 14px; font-weight: 700; margin: 0 0 4px;",
      "  display: flex; align-items: center; gap: 6px; }",
      ".scr-sec__sub { font-size: 13px; color: var(--text-secondary, #666);",
      "  margin: 0 0 10px; line-height: 1.55; }",
      ".scr-chips { display: flex; flex-wrap: wrap; gap: 5px; }",
      ".scr-chip { font-size: 12.5px; padding: 3px 8px; border-radius: 5px;",
      "  background: var(--bg-soft, #f5f6f8); color: var(--text-secondary, #555);",
      "  border: 1px solid rgba(0,0,0,.06); white-space: nowrap; }",
      ".scr-grp { margin-bottom: 11px; }",
      ".scr-grp__h { font-size: 12.5px; font-weight: 600; color: var(--text-secondary, #666);",
      "  margin: 0 0 5px; display: flex; align-items: center; gap: 5px; }",
      ".scr-pass .scr-chip { background: rgba(20,40,160,.06); border-color: rgba(20,40,160,.18);",
      "  color: var(--accent, #1428a0); }",
      ".scr-src { display: flex; flex-wrap: wrap; gap: 5px; }",
      ".scr-src__i { font-size: 12.5px; padding: 3px 8px; border-radius: 5px;",
      "  background: var(--bg-soft, #f5f6f8); border: 1px solid rgba(0,0,0,.06); }",
      ".scr-src__r { font-size: 11px; color: var(--text-secondary, #888); margin-left: 4px; }",
      ".scr-note { font-size: 12.5px; color: var(--text-secondary, #777); line-height: 1.6;",
      "  padding: 11px 13px; border-radius: 8px; background: var(--bg-soft, #f5f6f8); margin: 0; }",
      ".scr-empty { font-size: 13px; color: var(--text-secondary, #999); }",
      ".scr-loading { padding: 30px 0; text-align: center; color: var(--text-secondary, #888);",
      "  font-size: 14px; }",
    ].join("\n");
    document.head.appendChild(st);
  }

  function injectModal() {
    if (document.getElementById("screeningModal")) return;
    var d = document.createElement("div");
    d.className = "modal";
    d.id = "screeningModal";
    d.hidden = true;
    d.setAttribute("role", "dialog");
    d.setAttribute("aria-modal", "true");
    d.setAttribute("aria-labelledby", "screeningModalTitle");
    d.innerHTML = [
      '<div class="modal__backdrop" data-scr-close></div>',
      '<div class="modal__panel">',
      '  <div class="modal__header">',
      '    <h2 id="screeningModalTitle">기사 스크리닝 기준</h2>',
      '    <button class="modal__close" data-scr-close aria-label="닫기">',
      '      <i class="ti ti-x" aria-hidden="true"></i>',
      "    </button>",
      "  </div>",
      '  <div class="modal__body" id="screeningBody">',
      '    <div class="scr-loading">기준 불러오는 중…</div>',
      "  </div>",
      "</div>",
    ].join("\n");
    document.body.appendChild(d);
  }

  function renderBody(cfg) {
    var fr = (cfg && cfg.filterRules) || {};
    var block = fr.blockKeywords || [];
    var pass = (fr.allowOverrideKeywords || []).slice();
    var sources = cfg.rssSources || [];

    // 그룹핑 (config 에만 있고 그룹 미정의인 키워드는 '기타'로 수집)
    var seen = {};
    var groupsHtml = BLOCK_GROUPS.map(function (g) {
      var hit = g.keys.filter(function (k) {
        if (block.indexOf(k) === -1) return false;
        seen[k] = 1;
        return true;
      });
      if (!hit.length) return "";
      return [
        '<div class="scr-grp">',
        '  <p class="scr-grp__h"><i class="ti ' + g.icon + '" aria-hidden="true"></i>' + esc(g.label) + "</p>",
        '  <div class="scr-chips">' + chips(hit) + "</div>",
        "</div>",
      ].join("");
    }).join("");

    var rest = block.filter(function (k) {
      return !seen[k];
    });
    var restHtml = rest.length
      ? [
          '<div class="scr-grp">',
          '  <p class="scr-grp__h"><i class="ti ti-dots" aria-hidden="true"></i>기타</p>',
          '  <div class="scr-chips">' + chips(rest) + "</div>",
          "</div>",
        ].join("")
      : "";

    var srcHtml = sources.length
      ? sources
          .map(function (s) {
            return (
              '<span class="scr-src__i">' +
              esc(s.name) +
              '<span class="scr-src__r">' +
              esc(s.region || "") +
              "</span></span>"
            );
          })
          .join("")
      : '<span class="scr-empty">-</span>';

    return [
      '<div class="scr-flow">',
      '  <div class="scr-step"><span class="scr-step__no">1</span><span>',
      '    <span class="scr-step__t">RSS 수집</span>',
      '    <span class="scr-step__d">가전·HVAC·통상 정책 관련 피드 ' +
        sources.length +
        "개에서 기사를 수집합니다. 원문 링크 생존 여부(Dead-link)도 이 단계에서 확인합니다.</span>",
      "  </span></div>",
      '  <div class="scr-step"><span class="scr-step__no">2</span><span>',
      '    <span class="scr-step__t">키워드 필터 (코드 · 결정론적)</span>',
      '    <span class="scr-step__d">제목에 차단 키워드가 있으면 AI 분류 전에 제외합니다. 단, 우선 통과 키워드가 함께 있으면 차단하지 않고 다음 단계로 넘깁니다.</span>',
      "  </span></div>",
      '  <div class="scr-step"><span class="scr-step__no">3</span><span>',
      '    <span class="scr-step__t">AI 분류 (Claude)</span>',
      '    <span class="scr-step__d">본문을 읽고 생활가전(DA) 사업과 무관하면 최종 제외합니다. 통과 기사는 렌즈·등급·경쟁사·요약을 부여받습니다.</span>',
      "  </span></div>",
      "</div>",

      '<div class="scr-sec">',
      '  <p class="scr-sec__h"><i class="ti ti-rss" aria-hidden="true"></i>수집 소스 (' +
        sources.length +
        ")</p>",
      '  <div class="scr-src">' + srcHtml + "</div>",
      "</div>",

      '<div class="scr-sec scr-pass">',
      '  <p class="scr-sec__h"><i class="ti ti-shield-check" aria-hidden="true"></i>우선 통과 키워드 (' +
        pass.length +
        ")</p>",
      '  <p class="scr-sec__sub">차단 키워드와 겹쳐도 제외하지 않고 AI 분류로 넘깁니다. 통상·관세 정책, 캐리어 계열, 가전 IoT 플랫폼(스마트싱스·씽큐)이 해당합니다.</p>',
      '  <div class="scr-chips">' + chips(pass) + "</div>",
      "</div>",

      '<div class="scr-sec">',
      '  <p class="scr-sec__h"><i class="ti ti-filter-off" aria-hidden="true"></i>차단 키워드 (' +
        block.length +
        ")</p>",
      '  <p class="scr-sec__sub">제목에 포함되면 AI 분류 전에 제외됩니다. 이미 적재된 기사도 매 갱신 시 소급 제거됩니다.</p>',
      groupsHtml,
      restHtml,
      "</div>",

      '<div class="scr-sec">',
      '  <p class="scr-note"><i class="ti ti-info-circle" aria-hidden="true"></i> 오탐 방지를 위해 가전에서도 쓰이는 일반 단어(예: 센서·배터리·모니터)는 차단 목록에 넣지 않고 AI 분류 단계의 문맥 판단에 맡깁니다. 놓친 기사나 잘못 걸러진 기사가 보이면 기준을 조정할 수 있습니다.</p>',
      "</div>",
    ].join("\n");
  }

  function open() {
    injectStyles();
    injectModal();
    var modal = document.getElementById("screeningModal");
    var body = document.getElementById("screeningBody");
    modal.hidden = false;

    if (loaded) {
      body.innerHTML = renderBody(loaded);
      return;
    }
    body.innerHTML = '<div class="scr-loading">기준 불러오는 중…</div>';
    fetch(CONFIG_URL, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (cfg) {
        loaded = cfg;
        body.innerHTML = renderBody(cfg);
      })
      .catch(function (err) {
        console.error("스크리닝 기준 로드 실패:", err);
        body.innerHTML =
          '<div class="scr-loading">기준을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>';
      });
  }

  function close() {
    var m = document.getElementById("screeningModal");
    if (m) m.hidden = true;
  }

  document.addEventListener("click", function (e) {
    if (e.target.closest("#screeningInfoBtn")) {
      e.preventDefault();
      open();
      return;
    }
    if (e.target.closest("[data-scr-close]")) {
      close();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
})();
