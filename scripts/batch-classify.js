/**
 * Message Batches API 분류 실행기 — 입력·출력·캐시 토큰 전량 50% 할인
 *
 * 설계 원칙:
 *   - 동일 모델·동일 프롬프트·동일 단건 요청을 비동기 배치로 제출할 뿐이므로
 *     분류 결과물 품질에는 영향이 없다. 파싱·검증·백스톱·오역 가드는 전부
 *     기존 classifyOne 경로가 그대로 수행한다 (이 모듈은 원문 텍스트만 수확).
 *   - 어떤 실패 상황에서도 파이프라인이 죽지 않는다:
 *       배치 생성 실패 / 결과 수집 실패 / 연속 폴링 실패 → null 반환
 *         → 호출측(main)이 기존 동기 classifyAll 경로로 전체 폴백
 *       타임아웃 → 배치 취소 후 완료분만 수확, 미완료분은 classifyOne 라이브 폴백
 *   - 취소된 요청은 과금되지 않으므로 타임아웃 시에도 이중 과금은 완료분에 한정.
 *
 * 환경변수:
 *   USE_BATCH=0          배치 경로 비활성 (킬스위치, 기본 활성)
 *   BATCH_TIMEOUT_MS     폴링 제한 (기본 4분 — cron timeout-minutes:10 내 폴백 여유 확보)
 *   BATCH_POLL_MS        폴링 간격 (기본 15초)
 *
 * 반환: Map<item, responseText> — 실패·미완료 항목은 Map에 없음
 *       (호출측 classifyAll이 해당 항목만 classifyOne 라이브 호출)
 *       배치 자체 실패 시 null → 전체 동기 폴백
 */

const HARD_EXTRA_MS = 90 * 1000; // 취소 후 ended 대기 추가 한도

export async function runClassifyBatch(items, deps) {
  const { client, CLASSIFY_SYSTEM, buildUserPrompt, log } = deps;
  if (!items.length) return new Map();

  const TIMEOUT_MS = Number(process.env.BATCH_TIMEOUT_MS || 4 * 60 * 1000);
  const POLL_MS = Number(process.env.BATCH_POLL_MS || 15 * 1000);

  const requests = items.map((item, i) => ({
    custom_id: `art-${i}`,
    params: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      system: [
        {
          type: "text",
          text: CLASSIFY_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildUserPrompt(item) }],
    },
  }));

  let batch;
  try {
    batch = await client.messages.batches.create({ requests });
  } catch (err) {
    log(`배치 생성 실패(${err.message}) → 동기 분류로 전체 폴백`);
    return null;
  }
  log(`배치 제출: ${batch.id} (${requests.length}건, 제한 ${Math.round(TIMEOUT_MS / 1000)}초)`);

  const deadline = Date.now() + TIMEOUT_MS;
  const hardDeadline = deadline + HARD_EXTRA_MS;
  let timedOut = false;
  let cancelRequested = false;
  let pollFails = 0;

  while (batch.processing_status !== "ended") {
    if (!timedOut && Date.now() > deadline) {
      timedOut = true;
      log(`배치 폴링 제한 도달 → 취소 요청 후 완료분만 수확`);
    }
    if (timedOut && !cancelRequested) {
      cancelRequested = true;
      try {
        await client.messages.batches.cancel(batch.id);
      } catch (err) {
        log(`배치 취소 요청 실패(${err.message}) — ended 대기 계속`);
      }
    }
    if (Date.now() > hardDeadline) {
      log(`배치가 취소 후에도 종료되지 않음 → 동기 분류로 전체 폴백`);
      return null;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      batch = await client.messages.batches.retrieve(batch.id);
      pollFails = 0;
    } catch (err) {
      pollFails++;
      log(`배치 상태 조회 실패 ${pollFails}회(${err.message})`);
      if (pollFails >= 5) {
        log(`상태 조회 연속 실패 → 동기 분류로 전체 폴백`);
        return null;
      }
    }
  }

  const map = new Map();
  let ok = 0;
  let bad = 0;
  try {
    for await (const entry of await client.messages.batches.results(batch.id)) {
      const idx = Number(String(entry.custom_id || "").replace("art-", ""));
      const item = items[idx];
      if (!item) continue;
      if (entry.result?.type === "succeeded") {
        const text = (entry.result.message?.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (text) {
          map.set(item, text);
          ok++;
          continue;
        }
      }
      bad++;
    }
  } catch (err) {
    log(`배치 결과 수집 실패(${err.message}) → 동기 분류로 전체 폴백`);
    return null;
  }

  log(
    `배치 수확: 성공 ${ok}건 / 실패·취소 ${bad}건` +
      (timedOut ? " (타임아웃 부분수확, 잔여분은 라이브 폴백)" : "")
  );
  return map;
}
