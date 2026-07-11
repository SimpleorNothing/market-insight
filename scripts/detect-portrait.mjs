/**
 * detect-portrait.mjs
 *
 * 썸네일(og:image)이 "기자 증명사진/인물 얼굴 위주" 인지 Haiku 비전으로 판별하고,
 * 그런 경우 기사 태그·렌즈에 맞는 자체 제작 토픽 일러스트(SVG) 경로를 골라준다.
 *
 * 설계 원칙
 *  - 정밀도 우선: 확실히 인물 얼굴 위주일 때만 true. 애매하면 false(원본 사진 보존).
 *  - 실패는 null: 네트워크 오류·미지원 포맷·차단 응답은 null → 호출부에서 "미확정"으로 두고
 *    교체하지 않는다(오탐 삭제 방지, dead-link unknown 처리와 동일 철학).
 *  - 프론트 무변경: 호출부가 item.image 를 SVG 경로로 덮어쓰면 기존 렌더가 그대로 표시.
 */

const TOPIC_DIR = "assets/img/topics";

// 우선순위 순서대로 첫 매칭 버킷 채택. 태그/헤드라인 문자열에 키워드 포함 여부로 판단.
const TOPIC_RULES = [
  ["heat", ["폭염", "열사병", "온열질환", "무더위", "더위", "냉방안전", "열대야", "폭염경보", "heatwave"]],
  ["aircon", ["에어컨", "에어컨수요", "hvac", "냉방", "공조", "히트펌프", "냉난방", "실외기", "제습", "air condition"]],
  ["climate", ["엘니뇨", "라니냐", "기후변화", "기후", "지구온난화", "온실가스", "탄소", "친환경", "esg", "el nino", "climate"]],
  ["finance", ["실적", "실적발표", "매출", "영업이익", "순이익", "어닝", "컨센서스", "분기", "가이던스", "실적잔치", "earnings", "revenue"]],
  ["policy", ["정책", "규제", "보조금", "관세", "무역", "에너지효율", "효율등급", "표준", "인증", "법안", "환경규제", "tariff", "policy"]],
  ["tech", ["기술", "특허", "ai", "인공지능", "반도체", "칩", "스마트", "iot", "r&d", "개발", "혁신", "patent", "technology"]],
  ["retail", ["소비자", "프로모션", "출시", "신제품", "판매", "구독", "리뷰", "가격", "마케팅", "체험", "launch", "retail"]],
];

// 태그 매칭 실패 時 렌즈 기반 폴백.
const LENS_FALLBACK = {
  정책: "policy",
  기술: "tech",
  소비자: "retail",
  경쟁사: "news",
  거시: "climate",
};

/** 기사 항목 → 토픽 SVG 경로(repo 상대 경로). 항상 유효한 경로를 반환. */
export function pickTopicImage(item) {
  const tags = Array.isArray(item?.tags) ? item.tags.join(" ") : "";
  const hay = `${tags} ${item?.headline || ""}`.toLowerCase();
  for (const [bucket, kws] of TOPIC_RULES) {
    if (kws.some((k) => hay.includes(k.toLowerCase()))) {
      return `${TOPIC_DIR}/${bucket}.svg`;
    }
  }
  const byLens = LENS_FALLBACK[item?.lens];
  return `${TOPIC_DIR}/${byLens || "news"}.svg`;
}

const SUPPORTED = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

function mediaTypeFrom(contentType, url) {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (SUPPORTED[ct]) return SUPPORTED[ct];
  const m = String(url || "").toLowerCase().match(/\.(jpe?g|png|webp|gif)(?:\?|#|$)/);
  if (m) {
    const ext = m[1] === "jpg" ? "jpeg" : m[1];
    return `image/${ext}`;
  }
  return null;
}

const MAX_BYTES = 3_500_000; // Anthropic 이미지 한도(5MB) 이내 + 토큰 방어
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchImage(url, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let referer;
    try {
      referer = new URL(url).origin + "/";
    } catch {
      referer = undefined;
    }
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!res.ok) return null; // 403/404/429/5xx → 미확정
    const mediaType = mediaTypeFrom(res.headers.get("content-type"), res.url || url);
    if (!mediaType) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    return { mediaType, data: buf.toString("base64") };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const VISION_PROMPT =
  "이 이미지의 주요 피사체가 '특정 인물 1~2명의 얼굴/증명사진/프로필 사진(예: 기자·인터뷰 대상 얼굴)' 인가?\n" +
  "다음은 모두 false: 제품·가전·기기, 매장·건물·공장, 도표·그래프·인포그래픽, 풍경·날씨·자연, 여러 명이 나오는 행사/단체 사진, 로고·텍스트 이미지.\n" +
  "인물 얼굴이 화면을 지배할 때만 true. 조금이라도 애매하면 false.\n" +
  'JSON 한 줄만 출력: {"portrait": true} 또는 {"portrait": false}';

/**
 * @returns {Promise<boolean|null>} true=얼굴 위주, false=아님, null=미확정(교체하지 않음)
 */
export async function isPortraitImage(imageUrl, client) {
  if (!client || !imageUrl || !/^https?:\/\//i.test(imageUrl)) return null;
  const img = await fetchImage(imageUrl);
  if (!img) return null;
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 20,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
            { type: "text", text: VISION_PROMPT },
          ],
        },
      ],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const m = text.match(/"portrait"\s*:\s*(true|false)/i);
    if (m) return m[1].toLowerCase() === "true";
    if (/\btrue\b/i.test(text) && !/\bfalse\b/i.test(text)) return true;
    if (/\bfalse\b/i.test(text) && !/\btrue\b/i.test(text)) return false;
    return null;
  } catch {
    return null;
  }
}
