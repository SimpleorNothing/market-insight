# MI (Market Insight) 작업가이드

> **버전**: v1.1 (2026-07-18)
> **리포**: `SimpleorNothing/market-insight` · **서비스**: https://mi.samsungda.net
> **유지 규칙**: MI에 변경이 머지될 때마다 이 문서의 §7 업데이트 이력에 한 줄 추가하고, 절차가 바뀌면 해당 섹션을 함께 갱신한다.

---

## 1. 개요

MI는 가전(DA) 산업 경쟁 인텔리전스 시스템이다. RSS 피드로 뉴스를 수집하고, Claude(Haiku)로 필터링·분류·등급화하여 GitHub Pages 정적 대시보드(`mi.samsungda.net`)에 노출한다. 카드 단위로 사업부 영향 리포트(docx)를 생성할 수 있다.

- **렌즈(lens)**: 소비자 · 기술 · 경쟁사 · 정책 · 거시
- **액션 등급(grade)**: 긴급(≥4.5, 즉시 경영진 보고) · 주요(≥3.5, 주간 보고) · 주시(≥2.5) · 참고
- **영향도 4인자**: salesRelevance 0.4 / timeUrgency 0.25 / marketSize 0.2 / sourceReliability 0.15
- **경쟁사 15사** + `competitorBrands` 하위 브랜드 → 모기업 매핑 (예: KUKA→Midea, GE Appliances→Haier, KitchenAid→월풀, Shark/Ninja→샤크닌자)
- **역할분담 (MI ↔ 뉴스레터)**: MI는 **기사 원문 사실 정리에 충실** — summaryPoints는 원문 내용을 점 2~3개로 정리하며, 의미 해석·기회·위협 분석을 하지 않음. 기사 정리 + 기회·위협 해석은 **뉴스레터** 담당. (구 opportunity/threat 포인트 타입은 폐기 — 크론 실행 시 기존 데이터도 content 로 소급 정규화)
- **원문 충실 원칙**: 포인트는 원문의 구체 수치·고유명사를 그대로 옮김 (추상 표현으로 뭉개지 않음). 실적(어닝) 기사 표준 항목(우선순위): ①매출·이익 수치+전년比 증감 ②기록·이정표/컨센서스 대비 ③실적 요인·부문별 기여 ④가이던스 — 원문에 보도된 항목만 담고, 없는 항목은 생략.
- **정책·규제 기사 표준 항목**(lens="정책"): 규제의 도입·강화뿐 아니라 **연기·완화·재조정·철회의 '사유'를 반드시 포착**한다(우선순위): ①규제 조치·대상·시행 시점(과 그 변경) ②연기·완화·재조정 사유 — 비용 부담·형평성·업계/주민 반발 등 **원문의 구체 수치 그대로**(예: 전기 온수기 전환 설치비 약 $3,500, 가스 대비 +$600~1,600) ③예외·유예·보조 대상 범위 ④향후 절차·확정 일정 — 원문에 보도된 항목만 담고, 없는 항목은 생략. 유불리 해석은 뉴스레터 담당(MI는 사실만).

## 2. 아키텍처 / 데이터 흐름

```
Google News RSS 등 18개 피드 (scripts/config.json rssSources)
  → scripts/fetch-news.js  (GitHub Actions 크론 "Update news")
      ① blockKeywords 사전 차단 (allowOverrideKeywords가 우선 — 통상·관세는 차단 안 함)
      ② Google News 리다이렉트 URL → 발행처 실제 URL 디코딩 (batchexecute)
      ③ Haiku 분류: lens/grade/competitors/products/tags/summary/summaryPoints(원문 사실 정리 점 2~3개, 해석 금지)/insight, skip 규칙
         (시스템 프롬프트 cache_control 캐싱으로 비용 절감)
      ④ dedupe(similarityThreshold 0.22) · retention(전 등급 365일) · blockKeywords 소급 제거
      ⑤ og:image 부착(enrichImages, LLM 미사용)
  → data/news.json  (대용량 — API로 직접 로드 불가, raw curl 사용)
  → GitHub Pages 자동 배포 (.github/workflows/deploy-pages.yml, gen-version.mjs로 version.json 생성)
  → index.html + assets/js/app.js + assets/css/style.css
      · data/archive.json(2024~ 과거 시그널, id 900000+, 크론 영향 없음) 병합 로드
      · 리포트 생성 → Cloudflare Worker 프록시(reportProxyUrl, 공용 키) → 네이티브 OOXML docx
```

## 3. 파일 구조 (핵심)

| 경로 | 역할 |
|---|---|
| `scripts/config.json` | 피드·필터·등급·경쟁사·제품 전 설정 (운영의 90%는 이 파일 수정) |
| `scripts/fetch-news.js` | 수집·필터·분류·dedupe·retention·URL디코딩·이미지 파이프라인 |
| `scripts/backfill-*.mjs` | 1회성 소급 스크립트 (competitors 백필, og:image 백필 등) |
| `data/news.json` | 실시간 누적 데이터 (크론이 읽고 씀) |
| `data/archive.json` | 정적 과거 아카이브 40건 (크론 미접촉, archived:true) |
| `assets/js/app.js` / `assets/css/style.css` | 대시보드 UI (CI 편집국 팔레트, Pretendard, 최소 15px) |
| `worker/` | Cloudflare Worker 리포트 프록시 (wrangler, ALLOWED_ORIGINS) |
| `.github/workflows/` | update-news(크론) · deploy-pages (⚠ 토큰에 workflows scope 없어 MCP로 수정 불가 — 수동/Claude Code 필요) |
| `CNAME` | mi.samsungda.net |
| `.claude/settings.json` | Claude Code 자동 권한 (force push·hard reset·rm -rf·repo delete는 deny) |

## 4. 표준 작업 절차 (검증된 워크플로우)

1. **브랜치 생성** — `main`에서 `feat/…`, `fix/…`, `docs/…`
2. **원본 확보** — 소형 파일은 `get_file_contents`, `news.json` 등 대용량은 `curl raw.githubusercontent.com/<owner>/<repo>/<커밋SHA>/<path>`
3. **수정 + 검증**
   - JSON: `json.loads` 통과 확인
   - JS: `node --check` (ESM은 .mjs로 복사해 검사)
   - 문자열 치환 삽입 시 `assert count==1` 로 유일성 확인
4. **CJK 무결성 검증(필수)** — 커밋 전 로컬 blob SHA 계산 후 GitHub 반환 SHA와 대조:
   `sha1( b'blob %d\0' % len(bytes) + bytes )`
   MCP 인라인 전송은 대용량(40KB+) 파일에서 바이트 손상 리스크가 있음 — 대용량 UI 파일은 Claude Code 반영을 검토.
5. **커밋 → PR → squash 머지** — 이 리포의 표준은 squash. PR 본문에 배경/변경/검증을 기록.
6. **배포 확인** — main 머지 시 GitHub Pages 자동 배포. 새 피드는 다음 fetch-news 크론 실행부터 폴링.
7. **캐시버스터** — `app.js`/`style.css` 변경 시 `index.html`의 `?v=YYYYMMDD` 갱신 (미갱신 시 브라우저 캐시로 반영 안 보임 — PR #52 교훈).

## 5. 자주 하는 작업 레시피

- **RSS 피드 추가**: `config.json` `rssSources`에 항목 삽입. 쿼리는 `urllib.parse.quote`로 인코딩, `when:1d~14d` 윈도우 지정. 노이즈 방어는 3중 구조(blockKeywords → Haiku skip → maxArticlesPerSource=8)에 맡기고, 모호 단어는 구문으로 한정(예: WARN → "WARN notice"). 소급 수집은 불가(피드 윈도우 밖 과거 기사는 못 잡음).
- **차단 키워드 추가**: `filterRules.blockKeywords`. 헤드라인 매칭 시 분류 전 차단 + 기존 적재분도 매 실행 시 소급 제거. 통상·관세류는 `allowOverrideKeywords`가 우선.
- **분류 규칙 변경**: `fetch-news.js`의 CLASSIFY_SYSTEM 프롬프트 수정. 원칙 — competitors는 본문에 실제 거명된 회사만(포괄 표현 금지), lens와 competitors는 독립 판단.
- **기사 수동 삭제/정정**: `news.json` 직접 편집 PR. 기존 데이터 일괄 정정은 backfill 스크립트 작성(추가만, 삭제 금지 원칙).
- **과거 아카이브 추가**: `archive.json`에 id 900000+ 연번, 출처 URL 필수, 날짜 상한은 라이브 데이터와 중복되지 않게 유지.
- **UI 스타일**: `:root` 토큰만 수정(전 컴포넌트가 변수 참조). CI 팔레트 — 배경 #EDEFEC, 텍스트 #17222D, accent #46647E, radius 0. 폰트 Pretendard, 최소 15px. 하드코딩 색상 신규 추가 금지.
- **아카이브 검색(분석 질의)**: raw curl로 news.json 받아 Python으로 `items`를 `json.dumps` 키워드 필터.

## 6. 운영 원칙

- 설정(config)으로 풀 수 있는 문제는 코드 수정보다 설정을 우선한다.
- 하위호환 유지 — 새 필드(insight, summaryPoints, image)는 없으면 미표시/폴백, 기존 데이터 회귀 없음.
- API 키는 절대 클라이언트에 노출하지 않음(Worker secret). Worker 변경 시 재배포 필요(GH Actions 자동화됨 — secrets: CLOUDFLARE_API_TOKEN/ACCOUNT_ID).
- 이미지 등 외부 자산은 핫링크 금지 — 리포에 커밋해 self-contained로.
- 구조적 미포착이 발견되면(예: Anderson 사례) 원인(피드 쿼리/필터/프롬프트)을 규명한 뒤 최소 변경으로 보강.

## 7. 업데이트 이력 (PR 전수, 2026-05-17 ~ 2026-07-06)

> 전 PR squash 머지(#68 제외). 새 변경 머지 시 맨 위에 추가할 것.

### 2026-07
| PR | 일자 | 내용 |
|---|---|---|
| #116 | 07-21 | feat(config): 소비자·기술·경쟁사 렌즈 센싱 키워드 확충 |
| #115 | 07-21 | fix: 경쟁사 필터 칩에서 Haier를 Midea 다음으로 이동 |
| #113 | 07-21 | feat(sensing): 경쟁사 로보락·샤크닌자 추가 (15사) |
| #112 | 07-20 | 기업명 오역 차단 (현대건설 → 현대차 환각) + 수동 큐레이션 도입 |
| #111 | 07-18 | feat(fetch-news): 분류 프롬프트에 정책·규제 기사 표준 항목 추가 |
| #110 | 07-18 | docs: 정책·규제 기사 '연기·재조정 사유'(비용 등) 표준 항목 — 센싱/작업 가이드 반영 |
| #109 | 07-18 | feat(sensing): 경쟁사 주거·공간 신사업 판단 로직 보완 + 센싱 가이드 md/README 정비 |
| #108 | 07-18 | fix(group): 경쟁사 다중 기사를 단일 묶음 섹션으로 노출 |
| #107 | 07-15 | feat(classify): 거시 렌즈 요약에 매크로 지표 표준 항목 체크리스트 추가 |
| #106 | 07-13 | feat: mi.samsungda.net SSO 비밀번호 게이트(gate Worker) |
| #105 | 07-12 | feat: 서버 없이 더블클릭으로 여는 단독 실행 HTML(mi-local.html) |
| #104 | 07-12 | fix: 스크리닝 링크 좌측 시작점 정렬 |
| #103 | 07-12 | fix: 푸터 링크 CSS 미적용 문제 — 로드 즉시 주입 |
| #102 | 07-12 | fix: 스크리닝 링크 위치 — 푸터 우측 → 좌측 하단 |
| #101 | 07-12 | feat: 푸터 [기사 스크리닝 기준] 링크 + 안내 팝업 |
| #100 | 07-12 | feat(thumb): 기자 인물사진 썸네일 → 토픽 일러스트 자동 교체 |
| #99 | 07-12 | filter: 비-DA 카테고리(모바일·전장·배터리·통신) 차단 + 스마트싱스/씽큐 구제 |
| #98 | 07-12 | filter: 이미지센서 계열 기사 제외 (나노프리즘·ISOCELL 등) |
| #97 | 07-10 | data(news): 캐리어 4건 제목 정리·단일 브랜드 분류 |
| #96 | 07-10 | data(news): 캐리어 신규 4건 병합 (v2 분류) |
| #95 | 07-10 | chore(sensing): 캐리어 피드 수집 창 3d→7d (지난 1주일치 백필) |
| #94 | 07-10 | feat(sensing): 캐리어(오텍캐리어·캐리어에어컨) 센싱 대상 추가 |
| #93 | 07-09 | fix: Correct news ID 1522 article URL and image reference |
| #92 | 07-09 | fix: Google News URL 해석 시 다른 기사로 잘못 연결되는 버그 수정 |
| #90 | 07-08 | feat: 카드 썸네일 클릭 시 원문 새 탭 오픈 |
| #89 | 07-08 | fix: 뉴스 카운트 커밋 메시지에 archive.json 합산 |
| #88 | 07-07 | feat: 실적 기사 요약 기준을 우선순위 체크리스트로 전환 (원문 보도 항목만) |
| #87 | 07-07 | feat(ui): 카드 리포트 버튼 라벨 'AI 요약'으로 변경 |
| #86 | 07-07 | feat: 원문 충실 원칙 + 실적 기사 필수 3요소(매출·이익·전년比 증감) 규칙 |
| #85 | 07-07 | feat: MI↔뉴스레터 역할분담 — summaryPoints를 원문 사실 정리 전용으로 전환 |
| #84 | 07-07 | fix(ui): 카드 썸네일을 본문(요약) 높이에 정렬 |
| #83 | 07-07 | feat(ui): 렌즈 필터 행 제거 — 렌즈는 카드 #태그로 이동, 분류 우선순위 결정론화 |
| #82 | 07-07 | fix: news.json 데이터 손상 복구 (669건) + id 1470 이미지 필드 수정 |
| #81 | 07-07 | fix: 경쟁사 결정적 백스톱 — 거명 누락 competitors 강제 병합 + 소급 보정 |
| #80 | 07-07 | feat: 뉴스 카드 썸네일 렌즈 아이콘 폴백 (글자 → 픽토그램) |
| #79 | 07-06 | ci: WORK_GUIDE 자동 갱신 워크플로우 활성화 |
| #76 | 07-06 | 도구모음 런처 플로팅 → 헤더 내 고정 배치 |
| #75 | 07-06 | **Appliance Plant Watch 피드 추가** — 회사명 없는 지역발 공장 폐쇄·감원·리툴링 보도 커버 (Electrolux Anderson 사례 보강) |
| #74 | 07-06 | 리포트 생성 버튼 CI 고스트 스타일 전환 |
| #73 | 07-05 | 시장 동향 카드 **summaryPoints**(점·화살표: 내용/기회=파랑/위협=빨강) 신설, 구 summary 폴백 |
| #72 | 07-05 | LG·월풀 무이미지 기사에 업로드 실제 이미지 번갈아 표시 (cover/contain 분기) |
| #71 | 07-05 | LG·월풀 로고 variants[] 로테이션 (기사 id 기준 결정적 선택) |
| #70 | 07-05 | 태그를 박스형 → 액센트 해시태그 텍스트로 |
| #69 | 07-05 | LG 로고 외부 URL 핫링크 실패 수정 — self-contained SVG 전환 |
| #68 | 07-05 | (미머지 종료 — main 구현과 중복) |
| #67 | 07-05 | **뉴스카드 og:image 썸네일**(72px) + lens 색 플레이스홀더 폴백, backfill-og-image.mjs |
| #66 | 07-04 | 헤더 카피 조사 정리 |
| #65 | 07-03 | **CI 편집국 팔레트 전환** — :root 토큰 교체, radius 0 |
| #64 | 07-03 | 정렬·그룹 통합 — 최신순 고정, 그룹 렌즈/경쟁사(기본)/제품만 유지 |
| #63 | 07-03 | 아카이브 경쟁사 렌즈 보강 8→24건 (로보락·中 공세·LG 실적 등, 총 40건) |
| #62 | 07-03 | **data/archive.json 신설** — 2024~ 과거 시그널 24건, 크론 미접촉 병합 로드 |
| #61 | 07-03 | **신사업·비즈모델 센싱** — 피드 2종 + 프롬프트 중점 블록 + **insight 필드** 신설 |
| #60 | 07-03 | **통상·관세 정책 센싱** — 피드 2종 + allowOverrideKeywords 신설 + salesRelevance 특칙 |
| #59 | 07-03 | 반도체·부품 계열사 기사 제외 — blockKeywords 확장 + 소급 제거 로직 |
| #58 | 07-01 | lens·competitors 독립 판단으로 경쟁사 미분류 해소 + 79건 백필 |

### 2026-06
| PR | 일자 | 내용 |
|---|---|---|
| #57 | 06-30 | .claude/settings.json — Claude Code 자동 권한 (위험 명령 deny) |
| #56 | 06-29 | 폰트 표준 — 최소 15px + Pretendard 통일 |
| #55 | 06-28 | 페이지 제목 Market Insight → Market Sensing |
| #54 | 06-28 | 생태계 표 agent-guide 링크 갱신 |
| #53 | 06-28 | 헤더 italic 제거 |
| #52 | 06-28 | **캐시버스터(?v=) 도입** — 정적 자산 캐시 무효화 |
| #51 | 06-28 | 런처 우상단 고정 (→#76에서 헤더 복귀) |
| #50 | 06-28 | 갱신시각 YYYY.MM.DD HH:MM 형식 |
| #49 | 06-28 | 타이틀 "Market Insight / 시장 동향 Daily 센싱" 등 헤더 개선 |
| #48 | 06-28 | 업데이트 배지 표기 통일 (update : YYYY.M.D) |
| #47 | 06-27 | deploy-pages에 gen-version.mjs 스텝 추가 |
| #46 | 06-27 | 좌하단 업데이트 배지 (version.json) |
| #45 | 06-27 | 헤더에 사이트 갱신시점 별도 표시 (SITE_CHANGELOG) |
| #44 | 06-26 | docx 본문 행잉 인덴트 불릿 |
| #43 | 06-26 | 리포트 분석관점 복수선택(시간축/밸류체인/포지셔닝) + 예상 생성시간 |
| #42 | 06-26 | 리포트 모달 '전제품' 토글 |
| #41 | 06-26 | mi.samsungda.net 단독 배포로 문서 통일 |
| #40 | 06-26 | 도구모음 런처 최초 추가 |
| #39 | 06-26 | /mi 하위경로 base 태그 수정 (뉴스 0건 문제) |
| #38 | 06-26 | 필터 라벨 '시각' → '렌즈' |
| #37 | 06-26 | 경쟁사 태그 과다 부착 방지 — 직접 거명만 분류 |
| #36 | 06-26 | KPI 카드 렌즈 그룹(전체/소비자/경쟁사/기타) + 클릭 필터 |
| #28~35 | 06-26 | KPI·그룹·카드 UI 연쇄 개선 (경쟁사 KPI→렌즈 KPI, 기본그룹 경쟁사별, 미분류 마지막, 카드 등급표시 제거, init 오류 격리 등) |
| #26~27 | 06-26 | Worker 자동배포 + CORS 제한 해제 / 리포트 버튼 색 통일 |
| #22~25 | 06-25~26 | **mi.samsungda.net 커스텀 도메인**(CNAME) + Worker CORS·프록시 URL 복원 |
| #21 | 06-25 | **GitHub Pages 자동 배포 워크플로우** 신설 |
| #19~20 | 06-25 | TV 기사 자동 제외 필터 / 기사 2건 수동 삭제 |
| #18 | 06-06 | **docx 네이티브 OOXML 생성** — altChunk 제거, 모바일·웹 Word 호환 |

### 2026-05
| PR | 일자 | 내용 |
|---|---|---|
| #17 | 05-29 | **Cloudflare Worker 공용 키 프록시** 도입 (reportProxyUrl) |
| #16 | 05-28 | Google News URL 디코더 수정 (batchexecute 최신 방식) |
| #15 | 05-28 | 사내망 리다이렉트 오류 해결 — 발행처 실제 URL 변환 + 백필 |
| #14 | 05-27 | 분류 프롬프트 **cache_control 캐싱** — 입력 비용 절감 |
| #13 | 05-27 | 기간 필터 기본값 1일 |
| #12 | 05-24 | 리스트 뷰 3줄 구조 |
| #10~11 | 05-24 | 카드 그리드 3열 → 2열 |
| #8~9 | 05-20~21 | KUKA→Midea 매핑 + Midea/KUKA KR 피드 |
| #7 | 05-19 | KPI 카운트 필터 연동 |
| #5~6 | 05-19 | **보존기간 365일** + 날짜범위·키워드 검색 / KPI 24h 기준(→#7로 대체) |
| #4 | 05-18 | 조회기간 필터 (1일/1주/1개월/전체) |
| #3 | 05-18 | 프로모션·광고성 skip + 시의성 필터 |
| #2 | 05-18 | **dedupe**(bigram 유사도) + 시의성 필터 + Haier·competitorBrands 매핑 |
| #1 | 05-17 | 최초 기능 개선 — KPI 클릭 필터, 태그 필터, 리포트 양식 |
