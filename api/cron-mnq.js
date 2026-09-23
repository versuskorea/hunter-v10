// api/cron-mnq.js — Vercel Cron → GitHub Actions 워크플로 트리거
//
// GitHub Actions의 schedule은 부하 시 실행이 통째로 드롭된다(공식 미보장).
// 정각 실행이 필요한 MNQ 봇을 위해 Vercel Cron에서 한 번 더 깨운다.
// 양쪽이 다 돌아도 봇 내부의 last_date 중복 체크가 나중 것을 스킵한다.
//
// 필요 환경변수 (Vercel → Settings → Environment Variables)
//   GH_TOKEN  : GitHub Personal Access Token (workflow 권한)
//   CRON_KEY  : 수동 호출용 비밀키 (선택)
//
// 수동 테스트: /api/cron-mnq?key=<CRON_KEY>

const OWNER = 'versuskorea';
const REPO = 'hunter-v10';
const WORKFLOW = 'mnq-bot.yml';
const REF = 'main';

export default async function handler(req, res) {
  // Vercel Cron은 x-vercel-cron 헤더를 붙여서 호출한다.
  const fromCron = !!req.headers['x-vercel-cron'];

  // 쿼리 파싱 — req.query 가 비는 런타임이 있어 URL 에서 직접도 읽는다
  let qkey = (req.query && req.query.key) || '';
  if (!qkey && req.url) {
    try {
      qkey = new URL(req.url, 'http://x').searchParams.get('key') || '';
    } catch (e) { /* noop */ }
  }
  const want = (process.env.CRON_KEY || '').trim();
  const keyOk = want && String(qkey).trim() === want;

  if (!fromCron && !keyOk) {
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      debug: {
        gotKey: String(qkey).slice(0, 40),
        gotLen: String(qkey).trim().length,
        envSet: !!want,
        envLen: want.length,
        url: String(req.url || '').slice(0, 120),
      },
    });
  }

  const token = process.env.GH_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'GH_TOKEN not set' });
  }

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
      body: JSON.stringify({
        ref: REF,
        inputs: { force: 'false' },   // 평상시 실행 — 중복이면 봇이 알아서 스킵
      }),
    });

    // 성공은 204 No Content
    if (r.status === 204) {
      return res.status(200).json({
        ok: true,
        triggered: WORKFLOW,
        at: new Date().toISOString(),
        by: fromCron ? 'cron' : 'manual',
      });
    }

    const text = await r.text();
    return res.status(502).json({ ok: false, status: r.status, body: text.slice(0, 500) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e).slice(0, 300) });
  }
}
