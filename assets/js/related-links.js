// DA Market Insight — 같은 사건 관련기사 묶음 렌더
// 크론(dedupeMerged)이 같은 사건 기사를 대표 1건으로 접고 나머지를 rep.relatedArticles[]
// 로 보존한다. 이 파일은 각 카드에 "관련 기사 N건" 접힘 토글을 그려 출처를 잃지 않게 한다.
// app.js(대용량 CJK) 무수정 원칙에 따라 마크업·동작·스타일을 모두 자체 주입한다.
// app.js renderCard 는 window.renderRelatedLinks(n) 반환 HTML 을 카드 하단에 삽입할 뿐이다.
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // app.js 템플릿에서 동기 호출 → HTML 문자열 반환 (관련기사 없으면 빈 문자열)
  window.renderRelatedLinks = function (n) {
    var rel = (n && n.relatedArticles) || [];
    if (!Array.isArray(rel) || rel.length === 0) return "";

    var lis = rel
      .map(function (r) {
        var href = (r && (r.url || (r.source && r.source.url))) || "#";
        var src = (r && r.source && r.source.name) || "";
        return (
          '<li class="rel-links__item">' +
          '<a href="' +
          esc(href) +
          '" target="_blank" rel="noopener noreferrer">' +
          esc(r.headline || "") +
          "</a>" +
          (src ? '<span class="rel-links__src">' + esc(src) + "</span>" : "") +
          "</li>"
        );
      })
      .join("");

    return (
      '<div class="rel-links">' +
      '<button type="button" class="rel-links__toggle" aria-expanded="false">' +
      '<i class="ti ti-stack-2" aria-hidden="true"></i>' +
      "<span>관련 기사 " +
      rel.length +
      "건</span>" +
      '<i class="ti ti-chevron-down rel-links__chevron" aria-hidden="true"></i>' +
      "</button>" +
      '<ul class="rel-links__list" hidden>' +
      lis +
      "</ul>" +
      "</div>"
    );
  };

  // 펼침/접힘 — 카드가 필터·정렬 시 재렌더되므로 위임 방식(재바인딩 불필요)
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".rel-links__toggle");
    if (!btn) return;
    var wrap = btn.closest(".rel-links");
    var list = wrap && wrap.querySelector(".rel-links__list");
    if (!list) return;
    var willOpen = list.hasAttribute("hidden");
    if (willOpen) list.removeAttribute("hidden");
    else list.setAttribute("hidden", "");
    btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
    wrap.classList.toggle("rel-links--open", willOpen);
  });

  // 스타일 자체 주입 (카드 flat 톤 — radius 0, 서브틀 보더, secondary/tertiary 텍스트)
  var css =
    ".rel-links{margin:0 0 2px;padding:0 16px 10px}" +
    ".rel-links__toggle{display:inline-flex;align-items:center;gap:6px;" +
    "padding:4px 8px;border:1px solid var(--border-default);background:var(--bg-soft);" +
    "color:var(--text-secondary);font-family:var(--font-sans);font-size:12px;" +
    "line-height:1;cursor:pointer;border-radius:var(--radius-sm)}" +
    ".rel-links__toggle:hover{border-color:var(--border-strong);color:var(--text-primary)}" +
    ".rel-links__toggle .ti{font-size:14px}" +
    ".rel-links__chevron{transition:transform .15s ease}" +
    ".rel-links--open .rel-links__chevron{transform:rotate(180deg)}" +
    ".rel-links__list{list-style:none;margin:8px 0 0;padding:8px 0 0;" +
    "border-top:1px dashed var(--border-subtle)}" +
    ".rel-links__item{position:relative;padding:4px 0 4px 14px;font-size:12.5px;" +
    "line-height:1.45}" +
    '.rel-links__item::before{content:"";position:absolute;left:2px;top:12px;' +
    "width:4px;height:4px;background:var(--border-strong)}" +
    ".rel-links__item a{color:var(--text-secondary);text-decoration:none}" +
    ".rel-links__item a:hover{color:var(--accent);text-decoration:underline}" +
    ".rel-links__src{margin-left:6px;color:var(--text-tertiary);font-size:11px}";
  var style = document.createElement("style");
  style.setAttribute("data-rel-links", "");
  style.textContent = css;
  document.head.appendChild(style);
})();
