// DA Market Insight — 상단 KPI 카드 경쟁사 전환
// app.js(대용량) 무수정 원칙에 따라 독립 companion 모듈로 분리(topic-group.js와 동일 패턴).
// 기존 카드는 렌즈 그룹(전체·소비자·경쟁사·기타) 기준이라 "어느 회사가 많이 움직였나"를
// 한눈에 볼 수 없었다. 이 모듈은 조회기간 내 기사수 상위 2개 경쟁사를 카드로 승격하고
// 나머지를 '기타'로 합산한다. app.js 의 전역 renderStats / getFilteredNews 를 감싸(override)
// 카드 클릭·선택 표시(updateStatSelection)는 기존 로직을 그대로 재사용한다.
(function () {
  "use strict";

  // 카드로 승격할 상위 경쟁사 수 (전체 + 상위 N + 기타 = 2x2 그리드)
  var TOP_COUNT = 2;
  // '기타' 카드의 그룹 키. app.js 의 기존 분기("소비자"/"경쟁사"/"기타")와 충돌하지 않도록
  // 센티널 값을 쓴다 — 원본 getFilteredNews 는 이 값을 무시하고 통과시킨다.
  var OTHER_KEY = "__기타__";
  // 랭킹에서 제외할 회사. config.json 의 competitors 에는 자사(삼성전자)도 포함돼 있으나,
  // 이 카드는 "경쟁사 중 누가 많이 움직였나"를 보는 용도라 자사는 후보에서 민다.
  // (제외된 회사의 기사는 '기타'로 합산되며, 하단 경쟁사 칩 필터에서는 그대로 선택 가능)
  var EXCLUDE = ["삼성전자"];

  // renderStats() 가 조회기간 기준으로 매번 재계산하는 상위 경쟁사 목록
  var TOP = [];

  var SLOTS = [
    { card: "statCardTop1", label: "statTop1Label", value: "statTop1" },
    { card: "statCardTop2", label: "statTop2Label", value: "statTop2" },
  ];

  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function hasTopCompetitor(n) {
    var comps = n.competitors || [];
    for (var i = 0; i < comps.length; i++) {
      if (TOP.indexOf(comps[i]) !== -1) return true;
    }
    return false;
  }

  // 조회기간 내 기사수 기준 경쟁사 랭킹.
  // 한 기사에 같은 회사가 중복 태깅돼도 1건으로만 세도록 기사 단위 중복 제거.
  function rankCompetitors(items) {
    var counts = Object.create(null);
    items.forEach(function (n) {
      var seen = Object.create(null);
      (n.competitors || []).forEach(function (c) {
        var name = (c || "").trim();
        if (!name || seen[name] || EXCLUDE.indexOf(name) !== -1) return;
        seen[name] = true;
        counts[name] = (counts[name] || 0) + 1;
      });
    });
    return Object.keys(counts)
      .map(function (name) {
        return [name, counts[name]];
      })
      .sort(function (a, b) {
        return b[1] - a[1] || a[0].localeCompare(b[0], "ko");
      });
  }

  // ===== getFilteredNews override =====
  // 원본은 state.lensGroup 이 "소비자"/"경쟁사"/"기타" 일 때만 분기하므로,
  // 경쟁사명·센티널이 들어오면 그대로 통과한다. 그 뒤에 경쟁사 조건을 덧붙인다.
  var origGetFilteredNews = getFilteredNews;
  getFilteredNews = function (opts) {
    opts = opts || {};
    var base = origGetFilteredNews(opts);
    if (opts.ignoreFilters) return base;

    var group = state.lensGroup;
    if (!group) return base;

    if (group === OTHER_KEY) {
      return base.filter(function (n) {
        return !hasTopCompetitor(n);
      });
    }
    return base.filter(function (n) {
      return (n.competitors || []).indexOf(group) !== -1;
    });
  };

  // ===== renderStats override =====
  renderStats = function () {
    try {
      // KPI는 렌즈·경쟁사·제품 필터 무시, 기간만 반영
      var all = getFilteredNews({ ignoreFilters: true });
      var ranked = rankCompetitors(all).slice(0, TOP_COUNT);
      TOP = ranked.map(function (e) {
        return e[0];
      });

      // 기타 = 상위 경쟁사가 하나도 태깅되지 않은 기사.
      // 한 기사에 상위 2개사가 동시 태깅될 수 있어 전체 ≠ 카드 합계일 수 있다.
      var other = all.filter(function (n) {
        return !hasTopCompetitor(n);
      }).length;

      setText("statTotal", all.length);

      SLOTS.forEach(function (slot, i) {
        var card = document.getElementById(slot.card);
        if (!card) return;
        var entry = ranked[i];
        if (!entry) {
          // 해당 기간에 경쟁사 기사가 부족하면 카드를 감춘다
          card.hidden = true;
          card.dataset.lensgroup = "";
          return;
        }
        card.hidden = false;
        card.dataset.lensgroup = entry[0];
        setText(slot.label, entry[0]);
        setText(slot.value, entry[1]);
      });

      setText("statOther", other);

      // 기간 변경 등으로 선택 중이던 경쟁사가 상위권에서 빠지면 선택 해제
      if (state.lensGroup && state.lensGroup !== OTHER_KEY && TOP.indexOf(state.lensGroup) === -1) {
        state.lensGroup = null;
      }

      updateStatSelection();
    } catch (e) {
      console.error("renderStats(stat-cards) 오류:", e);
    }
  };
})();
