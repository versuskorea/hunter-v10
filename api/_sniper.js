// api/_sniper.js — sniper-bot 워크플로 트리거 공통 함수 (밑줄 파일은 라우트가 아님)
// 환경변수: GH_TOKEN (sniper-bot 저장소 Actions 쓰기 권한 필요), CRON_SECRET
const OWNER = 'versuskorea';
const REPO = 'sniper-bot';
const REF = 'main';

function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function dispatch(req, res, workflow, inputs) {
  const secret = (process.env.CRON_SECRET || '').trim();
  const auth = String(req.headers['authorization'] || '');
  if (!(secret.length >= 16 && safeEq(auth, `Bearer ${secret}`)))
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  const token = process.env.GH_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'GH_TOKEN not set' });
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflow}/dispatches`;
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
      body: JSON.stringify(inputs ? { ref: REF, inputs } : { ref: REF }),
    });
    if (r.status === 204)
      return res.status(200).json({ ok: true, repo: REPO, workflow, inputs: inputs || null, at: new Date().toISOString() });
    const text = await r.text();
    return res.status(502).json({ ok: false, status: r.status, body: text.slice(0, 500) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e).slice(0, 300) });
  }
}
