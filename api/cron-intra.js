// api/cron-intra.js — Vercel Cron → 웨이브(mnq-intra.yml) 트리거
// GitHub schedule이 통째로 빠지는 경우 대비 (10/1 밤 22:35~03:40 실행 전부 누락).
// 중복 실행돼도 concurrency + done 기록으로 겹치지 않음.
// 환경변수: GH_TOKEN, CRON_SECRET (cron-mnq.js와 같은 값 사용)

const OWNER = 'versuskorea';
const REPO = 'hunter-v10';
const WORKFLOW = 'mnq-intra.yml';
const REF = 'main';

function safeEq(a, b){
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const auth = String(req.headers['authorization'] || '');
  if (!(secret.length >= 16 && safeEq(auth, `Bearer ${secret}`)))
    return res.status(401).json({ ok: false, error: 'unauthorized' });

  const token = process.env.GH_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'GH_TOKEN not set' });

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'hunter-v10-cron',
      },
      body: JSON.stringify({ ref: REF, inputs: { test: 'false' } }),   // 실전 실행 (점검 모드 아님)
    });
    if (r.status === 204)
      return res.status(200).json({ ok: true, triggered: WORKFLOW, at: new Date().toISOString() });
    const text = await r.text();
    return res.status(502).json({ ok: false, status: r.status, body: text.slice(0, 500) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e).slice(0, 300) });
  }
}
