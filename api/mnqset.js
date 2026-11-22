// api/mnqset.js — MNQ 봇 설정 읽기·쓰기 (PIN 필요). hunter-v10 저장소 Actions Variables 중 허용된 것만.
//   GET  → 지금 값
//   POST { set: { 이름: 값 } }
// GH_TOKEN 에 hunter-v10 의 "Variables: Read and write" 권한이 있어야 한다.
const OWNER = 'versuskorea', REPO = 'hunter-v10';
const H = () => ({
  Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hunter-v10-mnqset', 'Content-Type': 'application/json',
});
const U = p => `https://api.github.com/repos/${OWNER}/${REPO}/actions/variables${p}`;

const num = (lo, hi, nm) => v => { const x = Number(v); if (!(x >= lo && x <= hi)) throw new Error(`${nm} 는 ${lo}~${hi}`); return String(x); };
const ALLOW = {
  MA_PAUSE: v => (String(v) === '200' ? '200' : '0'),          // 200 = 전일 종가가 200일선 아래면 봇 신규 매수 쉼
  PAUSE_BUY: v => (String(v) === '1' ? '1' : '0'),             // 1 = 봇 신규 매수 쉼 (매도는 그대로)
  SIZE_LEV: num(0, 12, 'SIZE_LEV'),                             // 계약 수 = 자산 × 배수 ÷ 계약가치
  INTRA_LEV: num(0, 10, 'INTRA_LEV'),                           // 웨이브 계약 수 배수
  INTRA_MAX: v => String(Math.max(0, Math.min(99, Math.trunc(Number(v) || 0)))),   // 웨이브 최대 계약
  TOTAL_PAID: num(100, 1e6, 'TOTAL_PAID'),                      // 총 납입액 (만원)
};
const SHOW = [...Object.keys(ALLOW), 'MODE', 'INTRA_MODE'];

function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

async function readAll() {
  const out = {};
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(U(`?per_page=30&page=${page}`), { headers: H() });
    if (r.status !== 200) throw new Error(`hunter-v10 Variables 읽기 실패 ${r.status} — GH_TOKEN 에 hunter-v10 권한이 필요해요`);
    const j = await r.json();
    for (const v of j.variables || []) out[v.name] = v.value;
    if ((j.variables || []).length < 30) break;
  }
  return out;
}
async function write(name, value, exists) {
  const body = JSON.stringify({ name, value: String(value) });
  let r = await fetch(U(exists ? `/${name}` : ''), { method: exists ? 'PATCH' : 'POST', headers: H(), body });
  if (r.status === 404 && exists) r = await fetch(U(''), { method: 'POST', headers: H(), body });
  if (r.status === 409 && !exists) r = await fetch(U(`/${name}`), { method: 'PATCH', headers: H(), body });
  if (![201, 204].includes(r.status)) throw new Error(`쓰기 실패 ${name} ${r.status} — GH_TOKEN 에 hunter-v10 쓰기 권한이 필요해요`);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const pin = (process.env.DASH_PIN || '').trim();
  if (!pin) return res.status(503).json({ ok: false, error: 'DASH_PIN 없음' });
  if (!safeEq(String(req.headers['x-pin'] || ''), pin)) return res.status(401).json({ ok: false, error: 'PIN 이 틀려요' });
  try {
    const vars = await readAll();
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const done = [];
      for (const [k, v] of Object.entries((b && b.set) || {})) {
        if (!ALLOW[k]) throw new Error(`${k} 는 여기서 못 바꿔요`);
        const val = ALLOW[k](v); await write(k, val, k in vars); vars[k] = val; done.push(k);
      }
      return res.status(200).json({ ok: true, done });
    }
    const out = {}; for (const k of SHOW) out[k] = k in vars ? vars[k] : null;
    return res.status(200).json({ ok: true, vars: out });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
}
