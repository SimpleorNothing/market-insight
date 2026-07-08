// DA Market Insight — 카드 썸네일(원문 이미지·기업 로고·플레이스홀더) 클릭 시
// 같은 카드의 헤드라인 원문 링크를 새 탭으로 오픈한다.
// 헤드라인 <a>가 이미 원문 URL을 들고 있으므로 별도 데이터 속성 없이 재사용.
(function () {
  document.addEventListener("click", function (e) {
    var thumb = e.target.closest(".news-card__thumb");
    if (!thumb) return;
    var card = thumb.closest(".news-card");
    if (!card) return;
    var link = card.querySelector(".news-card__headline a");
    if (!link) return;
    var href = link.getAttribute("href");
    if (!href || href === "#") return;
    window.open(href, "_blank", "noopener,noreferrer");
  });
})();
