// Vercel Serverless Function
// 사진 속 근무 일정을 클로드(Anthropic API)로 읽어서 JSON으로 돌려줘요.
//
// 설정 방법 (Vercel 대시보드):
//   1. 이 프로젝트의 Settings → Environment Variables 로 이동
//   2. ANTHROPIC_API_KEY 라는 이름으로 본인의 Anthropic API 키를 등록 (console.anthropic.com 에서 발급)
//   3. 저장 후 Deployments 탭에서 Redeploy 를 눌러야 새 환경변수가 적용돼요.
//
// 이 API 키는 여기(서버)에만 저장되고 브라우저로는 절대 내려가지 않아요.
//
// [중요] 이 코드를 다른 사람이 그대로 복사해서 자기 Vercel 계정에 재배포해도,
// ANTHROPIC_API_KEY는 깃허브 코드가 아니라 "이 프로젝트의" Vercel 환경변수에만
// 저장되어 있기 때문에 그 사람의 새 배포본에는 함께 딸려가지 않아요. 그 배포본은
// 자기 키를 새로 등록하지 않는 한 그냥 "서버 설정 안 됨" 에러만 떠요 — 종원님의
// 키가 남의 재배포본에서 쓰일 일은 구조적으로 없어요.
//
// 다만 "종원님이 직접 배포한 이 사이트"의 API 주소를 아는 사람이 브라우저 앱을
// 거치지 않고 그 주소를 직접 호출하는 건 막을 수 없어요. 아래 origin 체크는 이
// 사이트가 아닌 다른 곳에서 온 요청(직접 호출 등)을 걸러내는 최소한의 방어선이고,
// 완벽한 보안은 아니에요(요청 헤더는 마음만 먹으면 위조 가능). 진짜 안전장치는
// Anthropic 콘솔에서 이 키에 월 사용 한도(spending limit)를 걸어두는 거예요 —
// 무슨 일이 있어도 그 한도 이상은 비용이 나가지 않아요.
function isSameOriginRequest(req) {
  const host = req.headers.host;
  const originHeader = req.headers.origin || req.headers.referer;
  if (!host || !originHeader) return false;
  try {
    return new URL(originHeader).host === host;
  } catch (e) {
    return false;
  }
}

const IMPORT_PROMPT =
  "이 이미지는 한 직원의 유연근무(플렉스타임) 월간 출퇴근 예정 캘린더 화면입니다. " +
  "달력에 표시된 각 날짜의 출근 시작 시각과 퇴근 종료 시각을 읽어 주세요. " +
  "시간이 표시되지 않은 주말이나 완전 휴무일은 결과에서 제외하세요. " +
  "오직 아래 형식의 JSON 객체 하나만 답하세요, 다른 설명은 쓰지 마세요:\n" +
  '{"days":[{"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","note":null}]}';

const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BASE64_CHARS = 9_000_000; // base64 raw string length guard (~6.5MB image)

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "server_not_configured" });
    return;
  }

  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: "origin_not_allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
  }
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "invalid_json" });
    return;
  }

  const imageBase64 = body.imageBase64;
  const mediaType = ALLOWED_MEDIA_TYPES.includes(body.mediaType) ? body.mediaType : "image/jpeg";

  if (!imageBase64 || typeof imageBase64 !== "string") {
    res.status(400).json({ error: "missing_image" });
    return;
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    res.status(413).json({ error: "image_too_large" });
    return;
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
              { type: "text", text: IMPORT_PROMPT }
            ]
          }
        ]
      })
    });

    if (!upstream.ok) {
      const status = upstream.status;
      if (status === 429) {
        res.status(429).json({ error: "rate_limited" });
        return;
      }
      res.status(502).json({ error: "request_failed" });
      return;
    }

    const data = await upstream.json();
    const textBlock = Array.isArray(data.content)
      ? data.content.find((c) => c && c.type === "text")
      : null;
    const raw = textBlock ? textBlock.text : "";

    let parsed;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : raw);
    } catch (e) {
      res.status(502).json({ error: "invalid_model_json" });
      return;
    }

    if (!parsed || !Array.isArray(parsed.days)) {
      res.status(502).json({ error: "invalid_model_json" });
      return;
    }

    res.status(200).json({ days: parsed.days });
  } catch (e) {
    res.status(500).json({ error: "request_failed" });
  }
};
