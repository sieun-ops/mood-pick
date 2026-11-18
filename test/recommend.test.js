// node --test : 오픈하사를 가짜(fetch)로 바꿔 시험한다. 실제 키·네트워크를 쓰지 않는다.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { recommend, clearCache, maskPersonal, parseAnswer } from "../lib/recommend.js";
import handler from "../api/recommend.js";

const ENV = { HASA_API_KEY: "test-key-not-real" };
const GOOD = JSON.stringify({
  songs: [
    { title: "밤편지", artist: "아이유", why: "차분히 쉬고 싶을 때 좋아요." },
    { title: "Square", artist: "백예린", why: "비 오는 날 잘 어울려요." },
    { title: "사건의 지평선", artist: "윤하", why: "새 출발 기분을 북돋아요." },
  ],
  foods: [
    { menu: "뜨끈한 국밥", keyword: "국밥", why: "지친 몸을 데워 줘요." },
    { menu: "크림 파스타", keyword: "파스타", why: "기분 전환에 좋아요." },
    { menu: "떡볶이", keyword: "떡볶이", why: "친구랑 나눠 먹기 좋아요." },
  ],
});

const reply = (content, status = 200) => async () => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => ({ choices: [{ message: { content } }] }),
});

const input = { mood: "😩 지쳤어요", situation: "시험 끝남", area: "이문동" };

beforeEach(() => clearCache());

test("정상: 노래 3곡과 메뉴 3개, 링크가 붙어 돌아온다", async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, opts };
    return reply(GOOD)();
  };
  const r = await recommend(input, { env: ENV, fetchImpl });
  assert.equal(r.songs.length, 3);
  assert.equal(r.foods.length, 3);
  assert.match(r.songs[0].link, /youtube\.com/);
  assert.match(r.foods[0].link, /map\.naver\.com/);
  assert.match(decodeURIComponent(r.foods[0].link), /이문동 국밥 맛집/);
  // 주소·모델·키 위치 확인
  assert.equal(sent.url, "https://open.hasa.re.kr/v1/chat/completions");
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.model, "gemma-4-31b");
  assert.equal(body.messages[0].role, "system");
  assert.equal(sent.opts.headers.Authorization, "Bearer test-key-not-real");
});

test("400: 기분이 없거나 상황이 너무 길면 거절", async () => {
  await assert.rejects(recommend({ mood: "" }, { env: ENV, fetchImpl: reply(GOOD) }), { status: 400 });
  await assert.rejects(
    recommend({ mood: "좋아요", situation: "가".repeat(301) }, { env: ENV, fetchImpl: reply(GOOD) }),
    { status: 400 }
  );
  await assert.rejects(recommend(null, { env: ENV, fetchImpl: reply(GOOD) }), { status: 400 });
});

test("키 없음: 500, AI를 부르지 않는다", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return reply(GOOD)(); };
  await assert.rejects(recommend(input, { env: {}, fetchImpl }), (err) => {
    assert.equal(err.status, 500);
    assert.doesNotMatch(err.message, /sk-|key/i);
    return true;
  });
  assert.equal(called, false);
});

test("429: 한도 초과 안내 문구", async () => {
  await assert.rejects(recommend(input, { env: ENV, fetchImpl: reply("", 429) }), (err) => {
    assert.equal(err.status, 429);
    assert.match(err.message, /한도/);
    return true;
  });
});

test("시간 초과: 504와 안내 문구", async () => {
  const hang = (url, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  await assert.rejects(recommend(input, { env: ENV, fetchImpl: hang, timeoutMs: 50 }), (err) => {
    assert.equal(err.status, 504);
    assert.match(err.message, /20초/);
    return true;
  });
});

test("이상한 답: 한 번 더 받고, 그래도 이상하면 502", async () => {
  let n = 0;
  const once = async () => (n++ === 0 ? reply("음... 추천드리자면")() : reply(GOOD)());
  const r = await recommend(input, { env: ENV, fetchImpl: once });
  assert.equal(r.songs.length, 3);
  clearCache();
  await assert.rejects(recommend(input, { env: ENV, fetchImpl: reply("JSON 아님") }), { status: 502 });
});

test("개인정보 가리기", () => {
  const t = maskPersonal("010-1234-5678 a@b.com 202300442");
  assert.doesNotMatch(t, /1234|a@b|202300442/);
  assert.equal(parseAnswer("not json"), null);
});

test("Vercel 함수: GET은 405, 키 없음은 500 JSON", async () => {
  const mk = () => {
    const res = { headers: {}, code: 0, body: null };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };
  const r1 = mk();
  await handler({ method: "GET" }, r1);
  assert.equal(r1.code, 405);

  const saved = process.env.HASA_API_KEY;
  delete process.env.HASA_API_KEY;
  const r2 = mk();
  await handler({ method: "POST", body: { mood: "좋아요" } }, r2);
  assert.equal(r2.code, 500);
  assert.ok(r2.body.error);
  if (saved !== undefined) process.env.HASA_API_KEY = saved;
});

test("원인 코드: 공백 섞인 키는 정리, 가려진 키·403은 코드로 구분", async () => {
  let auth;
  const f = async (u, o) => { auth = o.headers.Authorization; return reply(GOOD)(); };
  await recommend(input, { env: { HASA_API_KEY: "  test-key \n" }, fetchImpl: f });
  assert.equal(auth, "Bearer test-key");
  clearCache();
  await assert.rejects(recommend(input, { env: { HASA_API_KEY: "sk-dev-…" }, fetchImpl: reply(GOOD) }), { code: "KEY_MASKED" });
  await assert.rejects(recommend(input, { env: ENV, fetchImpl: reply("", 403) }), { status: 500, code: "HASA_403" });
  await assert.rejects(recommend(input, { env: {}, fetchImpl: reply(GOOD) }), { code: "NO_KEY" });
});
