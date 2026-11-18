// Vercel 함수: POST /api/recommend  { mood, situation, area }
import { recommend, HttpError } from "../lib/recommend.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST로만 요청할 수 있어요." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "요청 형식이 올바르지 않아요." });
    }
  }

  try {
    const result = await recommend(body);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("recommend failed:", err?.name);
    return res.status(500).json({ error: "알 수 없는 오류가 났어요. 다시 시도해 주세요." });
  }
}
