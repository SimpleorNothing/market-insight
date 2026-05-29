# 공용 충전 키 프록시 (Cloudflare Worker)

리포트 생성 기능에서 **사용자마다 API 키를 입력하지 않고**, 미리 충전해 둔
**공용 Anthropic 키 하나**를 쓰도록 해주는 중계 서버입니다.

키는 Worker secret에 보관되어 **브라우저로 절대 내려가지 않습니다.** 그래서
정적 사이트(GitHub Pages)인데도 키 노출 없이 공용 키를 사용할 수 있습니다.

```
브라우저 ──POST(키 없음)──▶ Cloudflare Worker ──x-api-key: 공용키──▶ api.anthropic.com
```

## 1. 사전 준비

- Cloudflare 계정 (무료 플랜으로 충분)
- Node.js 18+ 와 `wrangler` CLI
  ```bash
  npm install -g wrangler
  wrangler login
  ```

## 2. 배포

```bash
cd worker

# 공용 충전 키를 secret 으로 등록 (입력값은 화면/코드에 남지 않음)
wrangler secret put ANTHROPIC_API_KEY
# 프롬프트에 sk-ant-api03-... 붙여넣기

# 허용 Origin 확인/수정: wrangler.toml 의 ALLOWED_ORIGINS
#   운영 도메인에 맞게 (예: https://samsungda.net)

# 배포
wrangler deploy
```

배포가 끝나면 다음과 같은 주소가 출력됩니다:

```
https://da-insight-anthropic-proxy.<your-subdomain>.workers.dev
```

## 3. 사이트에 연결

`scripts/config.json` 의 `reportProxyUrl` 에 위 주소를 넣고 커밋/푸시하세요.

```json
"reportProxyUrl": "https://da-insight-anthropic-proxy.<your-subdomain>.workers.dev",
```

- 값이 채워져 있으면: 사용자는 키 입력 없이 **공용 키**로 리포트를 생성합니다.
- 값이 비어 있으면(`""`): 기존처럼 **사용자가 각자 키를 입력**합니다(폴백).

## 4. 동작 확인

```bash
curl -X POST https://da-insight-anthropic-proxy.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -H "Origin: https://samsungda.net" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":50,"messages":[{"role":"user","content":"ping"}]}'
```

정상이면 Anthropic 응답 JSON이 돌아옵니다.

## 보안 / 남용 방지 메모

- **CORS Origin 제한**: `ALLOWED_ORIGINS` 에 등록된 도메인에서만 호출을 허용합니다.
  (브라우저 차원의 보호이며, 비브라우저 직접 호출까지 막지는 않습니다.)
- **모델 화이트리스트 + 토큰 상한**: Worker가 `claude-haiku-4-5-20251001` 외 모델과
  `max_tokens > 2000` 요청을 거부해, 공용 키가 임의 용도로 쓰이는 것을 제한합니다.
- 추가로 비용을 더 보호하려면 Cloudflare의 Rate Limiting 규칙이나
  간단한 공유 토큰 헤더 검증을 더할 수 있습니다. 필요하면 요청하세요.
- secret 으로 등록한 키는 `wrangler.toml`·코드·git 어디에도 저장되지 않습니다.
  절대 키를 `config.json` 이나 프론트엔드 코드에 직접 넣지 마세요(공개 노출됨).
