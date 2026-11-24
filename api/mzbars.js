// api/mzbars.js — 웅덩이 차트용 1분봉 (메리츠, 주간거래 포함). 읽기 전용, 주문 안 냄. PIN 필요.
//   GET /api/mzbars?s=SOXL  → { bars: [{ ts, open, high, low, close, src }] }  (ts = 봉 시작 UTC 초)
// - 메리츠 1분봉(최근 수십 개) + 봇이 쌓는 시세 기록(MANUAL_TICKS)을 합친다. 야후에 없는 주간거래를 채우는 용도.
// - 토큰: 봇과 같은 캐시(MANUAL_TOKEN)를 읽어 쓰고, 만료·무효일 때만 새로 받아 같은 칸에 넣는다 (dash.js 와 같은 방식).
import crypto from 'node:crypto';
import * as M from './_meritz.js';
import * as V from './_ghvars.js';
import { clock } from './_manual_core.js';

const SALT = 'manual-token:';
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
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
async function readVar(name) {
  const r = await fetch(`https://api.github.com/repos/versuskorea/sniper-bot/actions/variables/${name}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hunter-v10-mzbars' },
  });
  if (r.status !== 200) return undefined;
  return (await r.json()).value;
}

// 따뜻한 인스턴스 안에서는 메모리에 잠깐 들고 있는다 (GitHub·메리츠 호출 줄이기)
let TOK = null;
const CACHE = {};   // sym → { at, bars }
let TICKS = null, TICKS_AT = 0;

async function getToken(dead) {
  if (!dead && TOK && TOK.exp > Date.now()) return TOK;
  const s = await readVar('MANUAL_TOKEN');
  const t = s ? open_(s, SALT) : null;
  if (t && t.exp > Date.now() && !(dead && TOK && t.token === TOK.token)) return (TOK = t);   // 봇이 새로 받은 토큰이면 그걸 쓴다
  TOK = await M.issueToken();
  try { await V.write('MANUAL_TOKEN', seal(TOK, SALT), s !== undefined); } catch { /* 무시 */ }
  return TOK;
}
const idTs = id => Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8), +id.slice(8, 10), +id.slice(10, 12)) / 1000 - 9 * 3600 - 60;   // 메리츠 id 는 봉이 끝난 시각 → 시작 시각으로

async function meritzBars(sym) {
  const c = CACHE[sym];
  if (c && Date.now() - c.at < 2500) return c.bars;
  let rows;
  try { rows = await M.candles(await getToken(false), sym, 60); }
  catch (e) { if (e.code !== 'TOKEN_DEAD') throw e; rows = await M.candles(await getToken(true), sym, 60); }
  const bars = rows.map(b => ({ ts: idTs(b.id), open: b.o, high: b.h, low: b.l, close: b.c, src: 'mz' }));
  CACHE[sym] = { at: Date.now(), bars };
  return bars;
}
async function tickBars(sym) {
  if (!TICKS || Date.now() - TICKS_AT > 30000) {
    TICKS_AT = Date.now();
    try {
      const J = JSON.parse((await readVar('MANUAL_TICKS')) || '{}');
      const T = {};
      if (J && J.v === 2) for (const [k, a] of Object.entries(J.S || {})) T[k] = a.map(t => [t[0] + J.b, ...t.slice(1)]);
      else if (J && !J.v) Object.assign(T, J);
      TICKS = T;
    } catch { TICKS = TICKS || {}; }
  }
  return (TICKS[sym] || []).map(t => {
    const ts = t[0] * 60;
    return t.length > 2 ? { ts, open: t[1], high: t[2], low: t[3], close: t[4], src: 'tick' } : { ts, open: t[1], high: t[1], low: t[1], close: t[1], src: 'tick' };
  });
}

// 지금 진행 중인 1분봉: 메리츠 분봉은 끝난 봉만 줘서 최대 1분 늦다 → 현재가로 지금 봉을 만든다
const LIVE = {};   // sym → { ts, open, high, low, close }
async function livePx(sym) {
  const ses = clock(new Date()).session; if (ses === 'closed') return null;
  try { return await M.price(await getToken(false), sym, ses); }
  catch (e) { if (e.code !== 'TOKEN_DEAD') throw e; return await M.price(await getToken(true), sym, ses); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const pin = (process.env.DASH_PIN || '').trim();
  if (!pin) return res.status(503).json({ error: 'DASH_PIN 없음' });
  if (!safeEq(String(req.headers['x-pin'] || ''), pin)) return res.status(401).json({ error: 'PIN 이 틀려요' });
  const sym = String(req.query.s || 'SOXL').toUpperCase() === 'SOXS' ? 'SOXS' : 'SOXL';
  const out = new Map(), err = [];
  try { for (const b of await tickBars(sym)) out.set(b.ts, b); } catch (e) { err.push('기록 ' + (e.message || e)); }
  try { for (const b of await meritzBars(sym)) out.set(b.ts, b); } catch (e) { err.push('메리츠 ' + String(e.message || e).slice(0, 120)); }
  try {
    const p = await livePx(sym);
    if (p > 0) {
      const ts = Math.floor(Date.now() / 60000) * 60;
      let L = LIVE[sym];
      const cur = out.get(ts);   // 봇이 매분 처음에 찍은 값(tick)이 있으면 그걸 시가로
      if (!L || L.ts !== ts) { const prev = out.get(ts - 60); const o = cur && cur.src === 'tick' ? cur.open : prev ? prev.close : p; L = LIVE[sym] = { ts, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p }; }
      L.high = Math.max(L.high, p); L.low = Math.min(L.low, p); L.close = p;
      if (!cur || cur.src === 'tick') out.set(ts, { ...L, src: 'live' });
    }
  } catch (e) { err.push('현재가 ' + String(e.message || e).slice(0, 80)); }
  const bars = [...out.values()].filter(b => b.close > 0).sort((a, b) => a.ts - b.ts);
  return res.status(200).json({ sym, count: bars.length, bars, err: err.join(' · ') || undefined });
}
