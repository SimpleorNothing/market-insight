// DA Market Insight — 토픽 묶음 (정책·거시 카드 주제 클러스터링)
// app.js(대용량) 무수정 원칙에 따라 독립 companion 모듈로 분리(screening-info.js와 동일 패턴).
// 경쟁사·제품이 태깅되지 않는 정책·거시 카드(통상·관세 등)는 '경쟁사별' 보기에서 '경쟁사 미분류'
// 한 덩어리로 방치됐다. 이 모듈은 그 버킷을 공유 태그 기준 토픽으로 세분화하고, 새 '토픽별'
// 그룹 모드를 추가한다. app.js 의 전역 makeGroups 를 감싸(override) 렌더 로직은 그대로 재사용.
(function () {
  "use strict";

  // 표시 전용 토픽 정의 (screening-info.js 의 BLOCK_GROUPS 와 동일하게 여기서만 관리).
  // groups 순서대로 anyTags 교집합 first-match. 태그(+lens)에 하나라도 걸리면 그 토픽으로 묶음.
  var TOPIC_GROUPS = [
    {
      label: "美 통상·관세 (USMCA)",
      anyTags: [
        "USMCA", "관세", "관세정책", "통상협상", "통상정책", "무역협정",
        "무역정책", "무역적자", "원산지규정", "보호무역", "nearshoring",
        "tariff", "Section 232", "Section 301",
      ],
    },
    {
      label: "환경·에너지 규제",
      anyTags: [
        "에너지효율", "친환경", "탄소중립", "탄소배출", "환경규제",
        "전기요금", "보조금", "IRA", "냉매규제", "에너지스타",
      ],
    },
    {
      label: "거시·공급망",
      anyTags: [
        "환율", "금리", "원자재", "공급망", "물류", "인플레이션",
        "경기침체", "소비심리",
      ],
    },
  ];

  var MISC = "기타 이슈";
  // 그룹 정렬 시 항상 맨 뒤로 보낼 '미분류/기타' 버킷
  var TAIL = ["경쟁사 미분류", MISC];

  function matchTopic(n) {
    var hay = (n.tags || []).slice();
    if (n.lens) hay.push(n.lens);
    for (var i = 0; i < TOPIC_GROUPS.length; i++) {
      var g = TOPIC_GROUPS[i];
      for (var j = 0; j < g.anyTags.length; j++) {
        if (hay.indexOf(g.anyTags[j]) >= 0) return g.label;
      }
    }
    return null;
  }

  function bucketByTopic(items) {
    var map = new Map();
    items.forEach(function (n) {
      var key = matchTopic(n) || MISC;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(n);
    });
    return map;
  }

  function sortGroups(result) {
    result.sort(function (a, b) {
      var at = TAIL.indexOf(a.key) >= 0;
      var bt = TAIL.indexOf(b.key) >= 0;
      if (at && !bt) return 1;
      if (bt && !at) return -1;
      return b.items.length - a.items.length;
    });
    return result;
  }

  // app.js 전역 makeGroups 가 정의된 뒤에만 감싼다(로드 순서: app.js → 이 파일).
  if (typeof makeGroups !== "function") return;
  var original = makeGroups;

  // eslint-disable-next-line no-global-assign
  makeGroups = function (items) {
    // 순수 '토픽별' 보기: 경쟁사 유무 무관하게 전 카드를 토픽으로 묶음.
    if (typeof state !== "undefined" && state.group === "topic") {
      var tmap = bucketByTopic(items);
      var res = Array.from(tmap.entries()).map(function (e) {
        return { key: e[0], items: e[1] };
      });
      return sortGroups(res);
    }

    var groups = original(items);

    // '경쟁사별' 보기: '경쟁사 미분류'(엔티티 없는 정책·거시) 한 덩어리를 토픽으로 재분할.
    if (typeof state !== "undefined" && state.group === "competitor") {
      var idx = groups.findIndex(function (g) {
        return g.key === "경쟁사 미분류";
      });
      if (idx >= 0) {
        var misc = groups[idx].items;
        groups.splice(idx, 1);
        bucketByTopic(misc).forEach(function (v, k) {
          groups.push({ key: k, items: v });
        });
        groups = sortGroups(groups);
      }
    }
    return groups;
  };
})();
