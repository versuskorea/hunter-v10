// api/dash.js — 헌터 대시보드 데이터 (읽기 전용, 주문 안 냄)
//
// 한 번 부르면 계좌1·계좌2 잔고, 스나이퍼 장부·주문표, 웨이브·돌파·밤돌파·조건주문 상태, MNQ 상태를 모아 준다.
// 인증: 요청 헤더 x-pin 이 Vercel 환경변수 DASH_PIN 과 같아야 한다 (없으면 503 — 저장소가 공개라서 잔고를 막는다).
// 토큰: 봇이 쓰는 캐시(MANUAL_TOKEN·BO_TOKEN)를 그대로 읽고, 만료됐을 때만 새로 받아 같은 칸에 넣는다 (봇과 공유).
import crypto from 'node:crypto';
import * as M from './_meritz.js';
import * as V from './_ghvars.js';

const OWNER = 'versuskorea';

function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const keyOf = salt => crypto.createHash('sha256').update(salt + (process.env.CRON_SECRET || '')).digest();
function seal(obj, salt) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', keyOf(salt), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function open_(s, salt) {
  try {
    const [iv, tag, enc] = String(s).split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(salt), iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  } catch { return null; }
}

// 계좌 하나 읽기. keyEnv/secEnv: 그 계좌 앱키 환경변수 이름, varName/salt: 토큰 캐시 칸과 암호 소금
async function account(vars, { keyEnv, secEnv, varName, salt }) {
  const k0 = process.env.MERITZ_APP_KEY, s0 = process.env.MERITZ_APP_SECRET;
  try {
    if (!process.env[keyEnv] || !process.env[secEnv]) return { err: `${keyEnv} 없음` };
    process.env.MERITZ_APP_KEY = process.env[keyEnv];
    process.env.MERITZ_APP_SECRET = process.env[secEnv];
    let tok = vars[varName] ? open_(vars[varName], salt) : null;
    const fresh = async () => {
      tok = await M.issueToken();
      try { await V.write(varName, seal(tok, salt), varName in vars); } catch { /* 무시 */ }
    };
    if (!tok || !(tok.exp > Date.now())) await fresh();
    const run = async () => ({ hold: await M.holdings(tok), cash: await M.cashUSD(tok) });
    let r;
    try { r = await run(); } catch (e) { if (e.code !== 'TOKEN_DEAD') throw e; await fresh(); r = await run(); }
    return r;
  } catch (e) {
    return { err: String(e.message || e).slice(0, 160) };
  } finally {
    process.env.MERITZ_APP_KEY = k0; process.env.MERITZ_APP_SECRET = s0;
  }
}

async function yq(sym) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1m&includePrePost=true`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json(); const res = j.chart.result[0]; const m = res.meta;
    const cl = (res.indicators.quote[0].close || []).filter(x => x != null);
    return { last: cl.length ? cl[cl.length - 1] : m.regularMarketPrice, reg: m.regularMarketPrice, prev: m.chartPreviousClose ?? m.previousClose };
  } catch { return null; }
}

// 비공개 sniper-bot 저장소 state/*.json (GH_TOKEN 으로 읽기)
async function sniperFile(name) {
  try {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/sniper-bot/contents/state/${name}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github.raw+json', 'User-Agent': 'hunter-dash' },
    });
    if (!r.ok) return { err: `sniper-bot ${name} ${r.status}` };
    return await r.json();
  } catch (e) { return { err: String(e.message || e).slice(0, 120) }; }
}

async function pubJson(path) {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${OWNER}/hunter-v10/main/${path}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const pj = s => { try { return JSON.parse(s || 'null'); } catch { return null; } };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const pin = (process.env.DASH_PIN || '').trim();
  if (!pin) return res.status(503).json({ ok: false, error: 'DASH_PIN 이 아직 없어요 (Vercel 환경변수)' });
  if (!safeEq(String(req.headers['x-pin'] || ''), pin)) return res.status(401).json({ ok: false, error: 'PIN 이 틀려요' });

  const lite = !!(req.query && req.query.chart);   // 차트 화면: 계좌 조회 생략 (빠르게)
  let vars = {};
  try { vars = await V.readAll(); } catch (e) { vars = { _err: String(e.message || e) }; }

  const [q, plan, wave, cfg, mnq, mnqi] = await Promise.all([
    lite ? [null, null, null, null, null] : Promise.all(['SOXL', 'SOXS', 'QQQ', 'KRW=X', 'MNQ=F'].map(yq)),
    sniperFile('plan.json'), sniperFile('wave.json'), sniperFile('config.json'),
    pubJson('mnq_state.json'), pubJson('mnq_intra_state.json'),
  ]);
  const acct1 = lite ? null : await account(vars, { keyEnv: 'MERITZ_APP_KEY', secEnv: 'MERITZ_APP_SECRET', varName: 'MANUAL_TOKEN', salt: 'manual-token:' });
  const acct2 = lite ? null : await account(vars, { keyEnv: 'MERITZ2_APP_KEY', secEnv: 'MERITZ2_APP_SECRET', varName: 'BO_TOKEN', salt: 'bo-token:' });

  // 조건주문 — 줄과 줄별 상태
  const mstate = pj(vars.MANUAL_STATE) || {};
  const manual = {
    lines: String(vars.MANUAL || '').split('\n').map(s => s.trim()).filter(s => s && s !== '#'),
    rules: mstate.rules || mstate.R || null,
    raw: mstate,
  };

  // 웨이브 기록: 대시보드는 최근 30건, 차트(full)는 전부 (레이스·활동 피드용)
  const full = !!(req.query && req.query.full);
  if (wave && Array.isArray(wave.trades) && !full) wave.trades = wave.trades.slice(-30);

  // 하루 한 번 자산 기록 (HUNTER_DAILY) — 수익 레이스용. 대시보드를 연 날만 쌓인다.
  let daily = pj(vars.HUNTER_DAILY) || {};
  try {
    if (!lite && acct1 && !acct1.err && q[3]) {
      const key = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      if (!daily[key]) {
        const pxOf = s => (s === 'SOXL' ? q[0] : s === 'SOXS' ? q[1] : null);
        const val = a => (a && !a.err) ? (a.cash || 0) + Object.entries(a.hold || {}).reduce((t, [s, h]) => t + (h.qty || 0) * ((pxOf(s) && pxOf(s).last) || h.avg || 0), 0) : null;
        const cf = (mnq && mnq.cfg) || {}, mp = (q[4] && q[4].last) || (mnq && mnq.quote && mnq.quote.px) || 0;
        const unr = ((mnq && mnq.positions) || []).reduce((t, p) => t + (mp - p.entry) * 2 * (+p.qty || 1) * (+cf.fx || 1360), 0);
        daily[key] = {
          sn: plan && plan.ledger_E ? Math.round(plan.ledger_E) : null,
          sd: cfg && cfg.seed ? Math.round(+cfg.seed) : null,   // 그날 스나이퍼 시드 (레이스: 장부 − 시드)
          a1: Math.round(val(acct1) || 0), a2: Math.round(val(acct2) || 0),
          mnq: mnq ? Math.round((+cf.paid || 0) * 1e4 + (+mnq.realized || 0) + (+(mnqi && mnqi.realized) || 0) + unr) : null,
          fx: Math.round(q[3].last),
        };
        const ks = Object.keys(daily).sort().slice(-400); daily = Object.fromEntries(ks.map(k => [k, daily[k]]));
        await V.write('HUNTER_DAILY', JSON.stringify(daily), 'HUNTER_DAILY' in vars);
      }
    }
  } catch { /* 기록 실패는 무시 */ }
  if (wave && wave.hist) {
    if (req.query && req.query.full) { const ks = Object.keys(wave.hist).sort().slice(-20); wave.hist = Object.fromEntries(ks.map(k => [k, wave.hist[k]])); }
    else delete wave.hist;
  }

  res.status(200).json({
    ok: true, at: new Date().toISOString(),
    px: { SOXL: q[0], SOXS: q[1], QQQ: q[2], MNQ: q[4] }, fx: q[3] ? q[3].last : null,
    acct1, acct2,
    extraShares: Number(vars.EXTRA_SHARES || 0),
    sniper: { plan, cfg },
    wave,
    bo: { mode: vars.BO_MODE || 'PAPER', state: pj(vars.BO_STATE) },
    night: { mode: vars.NIGHT_MODE || 'OFF', state: pj(vars.NIGHT_STATE) },
    manual,
    mnq: mnq ? { ...mnq, hist: undefined, history: (mnq.history || []).slice(full ? -200 : -10) } : null,
    daily,
    mnqIntra: mnqi ? { ...mnqi, hist: undefined, history: undefined } : null,
  });
}
