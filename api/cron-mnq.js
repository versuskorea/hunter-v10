// api/cron-mnq.js — Vercel Cron → GitHub Actions 워크플로 트리거
//
// GitHub Actions의 schedule은 부하 시 실행이 통째로 드롭된다(공식 미보장).
// 정각 실행이 필요한 MNQ 봇을 위해 Vercel Cron에서 한 번 더 깨운다.
// 양쪽이 다 돌아도 봇 내부의 last_date 중복 체크가 나중 것을 스킵한다.
//
// 필요 환경변수 (Vercel → Settings → Environment Variables)
//   GH_TOKEN    : GitHub Personal Access Token (workflow 권한)
//   CRON_SECRET : 크론 인증 비밀값. 설정해두면 Vercel Cron 이 호출할 때
//                 Authorization: Bearer <CRON_SECRET> 헤더를 자동으로 붙인다.
//
// 수동 테스트: Vercel 대시보드 → Settings → Cron Jobs → Run
//   (주소창에서 직접 부르면 401 이 정상)

const OWNER = 'versuskorea';
const REPO = 'hunter-v10';
const WORKFLOW = 'mnq-bot.yml';
const REF = 'main';

// 길이가 달라도 시간 차이가 안 나게 비교
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
  const fromCron = secret.length >= 16 && safeEq(auth, `Bearer ${secret}`);

  if (!fromCron) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
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
        by: 'cron',
      });
    }

    const text = await r.text();
    return res.status(502).json({ ok: false, status: r.status, body: text.slice(0, 500) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e).slice(0, 300) });
  }
}
