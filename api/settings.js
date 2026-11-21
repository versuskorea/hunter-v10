// api/settings.js — 헌터 설정 읽기·쓰기 (PIN 필요). 주문은 내지 않고 봇 설정 칸만 바꾼다.
//   GET  → 지금 값
//   POST { set: { 이름: 값 } }      → sniper-bot 저장소 Variables 저장 (허용된 이름만)
//   POST { seed: 숫자 }             → sniper-bot state/config.json 의 seed (스나이퍼 장부 시드) 변경
//   POST { waveReset: true }        → sniper-bot state/wave.json 보유 기록만 비움 (실현손익·기록은 유지)
import * as V from './_ghvars.js';

const OWNER = 'versuskorea', REPO = 'sniper-bot';
const ALLOW = {
  EXTRA_SHARES: v => String(Math.trunc(Number(v))),
  WAVE_CASH: v => { const x = Number(v); if (!(x >= 0 && x <= 1)) throw new Error('WAVE_CASH 는 0~1'); return String(x); },
  WAVE_MODE: v => { const x = String(v).toUpperCase(); if (!['OFF', 'PAPER', 'LIVE'].includes(x)) throw new Error('WAVE_MODE 는 OFF/PAPER/LIVE'); return x; },
  BO_MODE: v => { const x = String(v).toUpperCase(); if (!['OFF', 'PAPER', 'LIVE'].includes(x)) throw new Error('BO_MODE 는 OFF/PAPER/LIVE'); return x; },
  NIGHT_MODE: v => { const x = String(v).toUpperCase(); if (!['OFF', 'PAPER', 'LIVE'].includes(x)) throw new Error('NIGHT_MODE 는 OFF/PAPER/LIVE'); return x; },
  NIGHT_W_UP: v => { const x = Number(v); if (!(x >= 0 && x <= 1)) throw new Error('0~1'); return String(x); },
  NIGHT_W_DN: v => { const x = Number(v); if (!(x >= 0 && x <= 1)) throw new Error('0~1'); return String(x); },
  // GitHub 변수는 빈 값을 못 받는다 → 줄이 하나도 없으면 '#'(주석, 봇은 무시)로 저장
  MANUAL: v => String(v).replace(/\r/g, '').split('\n').map(s => s.trim()).filter(s => s && s !== '#').join('\n') || '#',
};
const SHOW = [...Object.keys(ALLOW), 'MANUAL_RSI', 'MANUAL_STOP_TIGHT', 'MANUAL_MIN_STOPW'];

function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const GH = (path, opt = {}) => fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
  ...opt,
  headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hunter-settings', ...(opt.headers || {}) },
});
async function getFile(path) {
  const r = await GH(path); if (!r.ok) throw new Error(`${path} 읽기 ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}
async function putFile(path, data, sha, msg) {
  const r = await GH(path, { method: 'PUT', body: JSON.stringify({ message: msg, sha, content: Buffer.from(JSON.stringify(data, null, 1) + '\n').toString('base64') }) });
  if (!r.ok) throw new Error(`${path} 저장 ${r.status} ${(await r.text()).slice(0, 120)}`);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const pin = (process.env.DASH_PIN || '').trim();
  if (!pin) return res.status(503).json({ ok: false, error: 'DASH_PIN 없음' });
  if (!safeEq(String(req.headers['x-pin'] || ''), pin)) return res.status(401).json({ ok: false, error: 'PIN 이 틀려요' });

  try {
    const vars = await V.readAll();
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const done = [];
      if (b.set && typeof b.set === 'object') {
        for (const [k, v] of Object.entries(b.set)) {
          if (!ALLOW[k]) throw new Error(`${k} 는 여기서 못 바꿔요`);
          const val = ALLOW[k](v);
          await V.write(k, val, k in vars); vars[k] = val; done.push(k);
        }
      }
      if (b.seed != null) {
        const s = Number(b.seed);
        if (!(s >= 1000 && s <= 1e8)) throw new Error('시드가 이상해요');
        const f = await getFile('state/config.json');
        const old = f.data.seed; f.data.seed = Math.round(s * 100) / 100;
        await putFile('state/config.json', f.data, f.sha, `seed ${old} → ${f.data.seed} (헌터 설정)`);
        done.push(`seed ${old}→${f.data.seed}`);
      }
      if (b.waveReset) {
        const f = await getFile('state/wave.json');
        Object.assign(f.data, { pos: 0, qty: 0, entry: null, entry_t: null });
        await putFile('state/wave.json', f.data, f.sha, '웨이브 보유 기록 비움 (헌터 설정)');
        done.push('waveReset');
      }
      return res.status(200).json({ ok: true, done });
    }
    let cfg = null, wave = null;
    try { cfg = (await getFile('state/config.json')).data; } catch (e) { cfg = { err: e.message }; }
    try { const w = (await getFile('state/wave.json')).data; wave = { pos: w.pos, sym: w.sym, qty: w.qty, entry: w.entry, day: w.day }; } catch (e) { wave = { err: e.message }; }
    const out = {}; for (const k of SHOW) out[k] = k in vars ? vars[k] : null;
    return res.status(200).json({ ok: true, vars: out, cfg, wave });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
}
