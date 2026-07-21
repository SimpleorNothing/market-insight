# Market Insight

시장 동향을 Daily로 센싱합니다. RSS 자동 수집 + Claude AI 분류 + 사업부 영향 리포트 생성을 한 시스템으로 통합.

**배포 URL:** `https://mi.samsungda.net`
**수집 주기:** 1시간 (GitHub Actions cron)
**분류 모델:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)

> 🧭 **기획 도구 모음**(`samsungda.net`) 생태계의 일부입니다 — 허브 레포: [`samsungda-portal`](https://github.com/SimpleorNothing/samsungda-portal)

| 도구 | 진입 | 레포 |
|------|------|------|
| 클로드로 워드보고서 작성하기 | `agentguide.samsungda.net` | `agent-guide` |
| 보고서 자판기 | `report.samsungda.net` | `report-site` |
| Market Insight | `mi.samsungda.net` | `market-insight` ◀ **현재 레포** |
| 2030 미래 트렌드 | `2030.samsungda.net` | `2030-insight` |
| Quick Share | `quickshare.samsungda.net` | `QuickShare` |
| My Space | `space.samsungda.net` | `samsungda-space` |

## 📑 가이드 문서 (여기부터 보세요)

| 문서 | 위치 | 내용 |
|------|------|------|
| **센싱 가이드** ⭐ | [`docs/SENSING_GUIDE.md`](docs/SENSING_GUIDE.md) | **무엇을·어떻게 센싱하는지의 단일 기준** — 센싱 범위·3단 파이프라인·차단/우선통과 키워드·누락 사례와 보완 |
| 작업 가이드 | [`docs/WORK_GUIDE.md`](docs/WORK_GUIDE.md) | 운영 절차(브랜치·PR·검증)·아키텍처·PR 이력 |

> **센싱 기준을 바꾸려면** → 기준은 `docs/SENSING_GUIDE.md`, 실제 설정값은 `scripts/config.json`, 분류 로직은 `scripts/fetch-news.js`(`CLASSIFY_SYSTEM`)를 함께 갱신한다. 사이트 하단(푸터)의 **[기사 스크리닝 기준]** 팝업은 `assets/js/screening-info.js`가 `config.json`을 실시간 렌더한다.

## 디렉토리 구조

```
market-insight/                         (= 레포 루트, mi.samsungda.net 으로 단독 배포)
├── index.html                          뉴스 보드 메인 페이지
├── CNAME                               커스텀 도메인 (mi.samsungda.net)
├── assets/
│   ├── css/style.css
│   └── js/
│       ├── app.js                      데이터는 data/news.json 에서 fetch
│       └── screening-info.js           푸터 [기사 스크리닝 기준] 팝업 (config.json 실시간 렌더)
├── data/
│   └── news.json                       자동 갱신 대상 파일
├── docs/
│   ├── SENSING_GUIDE.md                ⭐ 센싱 기준(스크리닝·분류) — 먼저 읽기
│   └── WORK_GUIDE.md                   운영 절차·아키텍처·PR 이력
├── scripts/
│   ├── fetch-news.js                   RSS 수집 + Claude API 분류(CLASSIFY_SYSTEM)
│   ├── config.json                     RSS 소스 + 사업부 컨텍스트·필터
│   └── package.json
├── .github/
│   └── workflows/
│       └── update-news.yml             1시간 주기 자동 실행
├── .nojekyll
├── .gitignore
└── README.md
```

## 초기 셋업 (1회만)

### 1단계: 레포 푸시 + GitHub Pages 단독 배포

이 레포는 `samsungda.net/mi` 하위경로가 아니라 **단독 서브도메인 `mi.samsungda.net`** 으로 배포됩니다.

```bash
git clone https://github.com/SimpleorNothing/market-insight.git
cd market-insight
# 변경 후
git add .
git commit -m "..."
git push
```

레포 `Settings → Pages`:

- **Source**: `GitHub Actions` (`.github/workflows/deploy-pages.yml` 가 배포)
- **Custom domain**: `mi.samsungda.net` 입력 → Save (레포의 `CNAME` 파일과 동일)
  - "DNS check successful" 확인 후 **Enforce HTTPS** 체크
- DNS(도메인 등록기관): `mi` 를 `simpleornothing.github.io` 로 향하는 `CNAME` 레코드

> 옛 `samsungda.net/mi` 경로는 사용하지 않습니다. 포털(`samsungda-portal`)에 남아 있다면
> 해당 폴더를 제거하고 `https://mi.samsungda.net` 로 리다이렉트하세요.

### 2단계: GitHub Secrets 등록

레포 `Settings → Secrets and variables → Actions → New repository secret`

| 키 | 값 |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com 에서 발급한 키 |

### 3단계: Actions 권한 확인

레포 `Settings → Actions → General → Workflow permissions`

- `Read and write permissions` 선택

### 4단계: 첫 실행

`Actions → Update news → Run workflow` 버튼으로 수동 실행. 성공 後 매시간 자동 실행됩니다.

## 운영 (일상 작업)

### RSS 소스 추가·변경

`scripts/config.json` 의 `rssSources` 배열 편집:

```json
{
  "name": "조선비즈 IT",
  "url": "https://biz.chosun.com/site/data/rss/it.xml",
  "weight": 1.0
}
```

### 사업부 컨텍스트 갱신

`scripts/config.json` 의 `businessUnits` 객체 편집. 키워드·경쟁사·KPI를 정확히 등록할수록 AI 분류와 리포트 품질이 향상됩니다.

### 보존 기간 조정

`config.json` 의 `retention`:

```json
"retention": {
  "New": 30,
  "Deep": 60,
  "Insight": 90
}
```

### 비용 보호 한계

`config.json` 의 `limits`:

```json
"limits": {
  "maxArticlesPerRun": 30,
  "maxArticlesPerSource": 10
}
```

## 예상 비용

Claude Haiku 4.5 가격: $1.00/MTok 입력, $5.00/MTok 출력

분류 1건당:
- 입력 ~1,000 토큰 = $0.001
- 출력 ~250 토큰 = $0.00125
- **건당 약 $0.0023 (약 3원)**

운영 시나리오 (시간당 평균 5건 신규 분류):
- 시간당: $0.0115
- 일간: $0.276
- **월간 약 $8 (약 1.1만원)**

`maxArticlesPerRun: 30` 한계로 비용 폭주 차단됨.

## 로컬 테스트

API 키 없이 RSS 수집까지만 검증:

```bash
cd scripts
npm install
DRY_RUN=1 node fetch-news.js
```

전체 흐름 검증 (API 키 사용):

```bash
cd scripts
ANTHROPIC_API_KEY=sk-ant-... node fetch-news.js
```

브라우저에서 사이트 확인:

```bash
cd ..
python3 -m http.server 8080
# http://localhost:8080 접속
```

## 단독 실행 파일 (서버 없이 더블클릭)

로컬 웹서버조차 띄우지 않고 **`mi-local.html` 파일 하나를 더블클릭**하면
바로 뜨는 단독 버전을 만들 수 있습니다. 데이터(`news.json`·`archive.json`)·
`config.json`·CSS·JS·로컬 이미지를 모두 한 파일에 인라인하고, `fetch()`를
임베드 데이터로 가로채므로 `file://`에서도 동작합니다.

```bash
cd scripts
npm install          # 최초 1회 (의존성 없음 — Node 내장 모듈만 사용)
npm run build:standalone
# → 레포 루트에 mi-local.html 생성
```

생성된 `mi-local.html`을 아무 PC에나 복사해 더블클릭하면 됩니다.

- **서버 불필요**: GitHub Pages·python http.server 등 아무것도 필요 없음.
- **데일리 갱신**: 최신 데이터로 새로 만들려면
  `node fetch-news.js`(뉴스 갱신) → `npm run build:standalone`(재빌드) 순으로
  실행하면 됩니다. PC 작업 스케줄러(Windows)·cron(Mac/Linux)에 이 두 줄을
  하루 1회 걸어두면 자동화됩니다.
- **주의점**
  - 폰트·아이콘(CDN)과 기사 썸네일(외부 URL)은 그대로 두어 파일을 가볍게
    유지합니다 → **인터넷 되는 PC 전제**. 완전 오프라인이면 이 CDN·이미지도
    인라인해야 합니다(파일 대폭 증가).
  - 파일은 **빌드 시점의 스냅샷**입니다. 새 뉴스는 재빌드해야 반영됩니다.
  - 리포트 생성은 로컬(`file://`)에서 공용 프록시가 막히므로, 단독 빌드는
    `reportProxyUrl`을 비워 **사용자 각자 API 키 직접 입력 모드**로 폴백합니다.

## 트러블슈팅

### Actions 실행 실패 시

1. Actions 탭에서 실패 로그 확인
2. `ANTHROPIC_API_KEY` Secret 등록 여부 확인
3. RSS URL 응답 확인 (매체 측 RSS 폐쇄·이전 可)
4. API 잔액 확인 (console.anthropic.com)

### 분류 결과가 이상한 경우

`scripts/fetch-news.js` 의 `CLASSIFY_SYSTEM` 프롬프트 수정. 사업부 키워드를 `config.json` 에서 더 구체적으로 보강하면 정확도가 빠르게 향상됩니다.

### Actions cron 지연

GitHub Actions cron 은 무료 플랜에서 최대 1시간 지연 발생 可. 즉시 실행이 필요하면 `workflow_dispatch` 수동 트리거 사용.

## 사내 보안 고려사항

- 레포 Public 사용이 불가하면 GitHub Enterprise 또는 사내 GitLab CI 로 동일 워크플로우 이식 可
- API 키는 반드시 Secrets 사용 (코드 內 하드코딩 절대 금지)
- 사내 매체 RSS 사용 時 사내망 접근 가능한 self-hosted runner 필요

## 다음 단계 (선택)

- 사업부 영향 리포트 백엔드 연동: `app.js` 의 `generateReport()` 함수를 별도 docx 생성 API로 교체
- 신규 Insight 신호 발생 時 사내 Slack·이메일 자동 발송 (Actions 워크플로우 추가)
- 카테고리별 추세 그래프, 사업부별 신호 강도 히트맵 추가

## 라이선스

사내 도구 (내부 사용 限).
