// 기분·상황 → 노래 3곡 + 맛집(메뉴) 3곳 추천의 핵심 로직.
// Vercel 함수(api/recommend.js)와 시험(test/)이 함께 쓴다.
// 키는 process.env.HASA_API_KEY 에서만 읽고, 어디에도 출력하지 않는다.

export const HASA_URL = "https://open.hasa.re.kr/v1/chat/completions";
export const MODEL = "gemma-4-31b";
export const TIMEOUT_MS = 20_000;
export const MAX_MOOD = 30;
export const MAX_SITUATION = 300;
export const MAX_AREA = 30;

// 지시문: 역할 · 형식 · 근거 · 금지 (12주차 슬라이드 11)
export const SYSTEM_PROMPT = [
  "너는 사용자의 기분과 상황에 맞춰 노래와 먹을 것을 추천하는 도우미다.",
  "형식: 아래 JSON 하나만 출력한다. 다른 글, 코드블록 표시는 쓰지 않는다.",
  '{"songs":[{"title":"","artist":"","why":""}],"foods":[{"menu":"","keyword":"","why":""}]}',
  "- songs는 정확히 3개. 실제로 존재하는 곡만, 제목과 가수를 정확히. 확실하지 않은 곡은 넣지 않는다.",
  "- foods는 정확히 3개. 특정 가게 이름은 지어내지 말고 메뉴/음식 종류만(예: 뜨끈한 국밥).",
  "- keyword는 지도에서 검색할 짧은 말(예: 국밥, 파스타). 2~6자.",
  "- why는 사용자의 기분·상황과 연결한 한 문장, 40자 이내, 존댓말.",
  "근거: 사용자가 준 기분과 상황만 근거로 한다.",
  "금지: 광고, 개인정보 언급, 술·약물 권유, 의학적 조언. 기분이 매우 위험해 보이면 why에 도움을 청하라는 말을 부드럽게 넣는다.",
].join("\n");

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code; // 원인 구분용(키 값은 절대 담지 않음)
  }
}

// 이름·전화번호·이메일·학번처럼 보이는 것은 AI에 보내기 전에 가린다.
export function maskPersonal(text) {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[이메일]")
    .replace(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g, "[전화번호]")
    .replace(/\b20\d{7}\b/g, "[학번]");
}

export function validateInput(body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "요청 형식이 올바르지 않아요.");
  }
  const mood = typeof body.mood === "string" ? body.mood.trim() : "";
  const situation = typeof body.situation === "string" ? body.situation.trim() : "";
  const area = typeof body.area === "string" ? body.area.trim() : "";

  if (!mood) throw new HttpError(400, "지금 기분을 골라 주세요.");
  if (mood.length > MAX_MOOD) throw new HttpError(400, `기분은 ${MAX_MOOD}자 이내로 적어 주세요.`);
  if (situation.length > MAX_SITUATION) {
    throw new HttpError(400, `상황은 ${MAX_SITUATION}자 이내로 줄여 주세요.`);
  }
  if (area.length > MAX_AREA) throw new HttpError(400, `동네는 ${MAX_AREA}자 이내로 적어 주세요.`);
  return { mood, situation, area };
}

// 모델 답에서 JSON을 꺼내 형식을 검사한다. 형식이 틀리면 null.
export function parseAnswer(content) {
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  const songs = Array.isArray(data.songs) ? data.songs.filter((s) => s && str(s.title) && str(s.artist)) : [];
  const foods = Array.isArray(data.foods) ? data.foods.filter((f) => f && str(f.menu)) : [];
  if (songs.length < 3 || foods.length < 3) return null;
  return {
    songs: songs.slice(0, 3).map((s) => ({
      title: s.title.trim().slice(0, 60),
      artist: s.artist.trim().slice(0, 40),
      why: str(s.why) ? s.why.trim().slice(0, 80) : "",
    })),
    foods: foods.slice(0, 3).map((f) => ({
      menu: f.menu.trim().slice(0, 30),
      keyword: (str(f.keyword) ? f.keyword : f.menu).trim().slice(0, 15),
      why: str(f.why) ? f.why.trim().slice(0, 80) : "",
    })),
  };
}

// 노래는 유튜브 검색, 맛집은 네이버 지도 검색 링크로 연결(가게 이름을 지어내지 않기 위해).
export function addLinks(result, area) {
  return {
    songs: result.songs.map((s) => ({
      ...s,
      link: "https://www.youtube.com/results?search_query=" + encodeURIComponent(`${s.title} ${s.artist}`),
    })),
    foods: result.foods.map((f) => ({
      ...f,
      link: "https://map.naver.com/p/search/" + encodeURIComponent(`${area ? area + " " : ""}${f.keyword} 맛집`),
    })),
  };
}

async function callHasa({ apiKey, userText, fetchImpl, signal }) {
  let res;
  try {
    res = await fetchImpl(HASA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userText },
        ],
        max_tokens: 700,
        temperature: 0.8,
      }),
      signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new HttpError(504, "AI 응답이 20초를 넘었어요. 잠시 뒤 다시 시도해 주세요.", "TIMEOUT");
    }
    throw new HttpError(502, "AI 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.", "HASA_UNREACHABLE");
  }

  if (res.status === 429) {
    throw new HttpError(429, "AI 사용 한도에 걸렸어요(분당 10회·하루 500회). 1분쯤 뒤 다시 시도해 주세요.", "HASA_429");
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(
      500,
      "서비스 설정 문제로 AI를 부를 수 없어요. 운영자에게 알려 주세요.",
      `HASA_${res.status}`
    );
  }
  if (!res.ok) {
    throw new HttpError(502, "AI 서버가 잠시 응답하지 않아요. 다시 시도해 주세요.", `HASA_${res.status}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

// 같은 질문은 10분 동안 저장해 다시 쓴다(한도 절약). 함수 인스턴스가 살아 있는 동안만 유효.
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

export function clearCache() {
  cache.clear();
}

export async function recommend(body, { env = process.env, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const { mood, situation, area } = validateInput(body);

  // 붙여넣을 때 섞인 공백·줄바꿈·따옴표를 지운다.
  const apiKey = (env.HASA_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!apiKey) {
    throw new HttpError(500, "서비스 설정 문제로 AI를 부를 수 없어요. 운영자에게 알려 주세요.", "NO_KEY");
  }
  if (apiKey.includes("…") || apiKey.includes("...")) {
    throw new HttpError(500, "서비스 설정 문제로 AI를 부를 수 없어요. 운영자에게 알려 주세요.", "KEY_MASKED");
  }

  const userText = maskPersonal(
    `기분: ${mood}\n상황: ${situation || "(적지 않음)"}${area ? `\n동네: ${area}` : ""}`
  );

  const cacheKey = userText;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 형식이 맞지 않는 답은 걸러 내고 한 번 더 받는다(슬라이드 12 '이상한 답').
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = await callHasa({ apiKey, userText, fetchImpl, signal: controller.signal });
      const parsed = parseAnswer(content);
      if (parsed) {
        const value = addLinks(parsed, area);
        cache.set(cacheKey, { at: Date.now(), value });
        return value;
      }
    }
    throw new HttpError(502, "AI 답의 형식이 이상해서 걸러 냈어요. 다시 시도해 주세요.", "BAD_FORMAT");
  } finally {
    clearTimeout(timer);
  }
}
