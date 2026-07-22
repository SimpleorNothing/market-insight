// related-articles.js — 같은 사건으로 병합된 기사(relatedArticles[])를 카드 하단에
// 접이식 "관련 기사 N건" 블록으로 렌더한다. app.js renderCard() 에서 호출된다.
// 네이티브 <details> 사용 → 별도 이벤트 배선 불필요. 자체 완결형(escape·상대시간 내장)이라
// app.js 의존성이 없고, 로드 실패 시에도 renderCard 의 typeof 가드로 카드가 정상 렌더된다.
(function () {
  var STYLE_ID = "related-articles-css";
  if (!document.getElementById(STYLE_ID)) {
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = [
      ".news-card__related{margin-top:8px;font-size:13px;color:var(--text-tertiary,#9AA6A0);}",
      ".news-card__related>summary{cursor:pointer;list-style:none;color:var(--text-secondary,#5C6B79);user-select:none;display:inline-flex;align-items:center;gap:4px;}",
      ".news-card__related>summary::-webkit-details-marker{display:none;}",
      ".news-card__related>summary::before{content:'\\25B8';font-size:11px;transition:transform .15s ease;}",
      ".news-card__related[open]>summary::before{transform:rotate(90deg);}",
      ".news-card__related>summary:hover{color:var(--accent,#46647E);}",
      ".news-card__related ul{list-style:none;margin:6px 0 0;padding:6px 0 0 14px;border-top:1px solid var(--border-subtle,#E1E4DF);}",
      ".news-card__related li{margin:0 0 5px;line-height:1.4;}",
      ".news-card__related li:last-child{margin-bottom:0;}",
      ".news-card__related a{color:var(--text-secondary,#5C6B79);text-decoration:none;}",
      ".news-card__related a:hover{color:var(--accent,#46647E);text-decoration:underline;}",
      ".news-card__related .rel-src{color:var(--text-tertiary,#9AA6A0);}",
    ].join("");
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function relTime(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var m = Math.max(0, Math.floor((Date.now() - t) / 60000));
    if (m < 60) return m + "분 前";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "시간 前";
    return Math.floor(h / 24) + "일 前";
  }

  window.renderRelatedArticles = function (n) {
    var rel = n && n.relatedArticles;
    if (!Array.isArray(rel) || rel.length === 0) return "";
    var items = rel
      .map(function (r) {
        var href = r.url || "";
        var head = esc(r.headline || "(제목 없음)");
        var link = href
          ? '<a href="' +
            esc(href) +
            '" target="_blank" rel="noopener noreferrer">' +
            head +
            "</a>"
          : head;
        var parts = [];
        if (r.source) parts.push(esc(r.source));
        var rt = relTime(r.publishedAt);
        if (rt) parts.push(rt);
        var src = parts.length
          ? ' <span class="rel-src">· ' + parts.join(" · ") + "</span>"
          : "";
        return "<li>" + link + src + "</li>";
      })
      .join("");
    return (
      '<details class="news-card__related">' +
      "<summary>관련 기사 " +
      rel.length +
      "건</summary>" +
      "<ul>" +
      items +
      "</ul>" +
      "</details>"
    );
  };
})();
