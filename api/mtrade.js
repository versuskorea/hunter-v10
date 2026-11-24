// api/mtrade.js — 손 주문(매도 줄) 체결 기록을 직접 보충한다 (PIN 필요, 주문 안 냄)
//   POST { t, d, sym, qty, px, ref, why }   → MANUAL_STATE.trades 에 한 건 추가 (봇 기록 기능 전 체결 보충용)
//   t: 체결 시각(ms) · d: 미국 거래일 YYYY-MM-DD · ref: 기준가(손익 계산용)
import * as V from './_ghvars.js';

function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const pin = (process.env.DASH_PIN || '').trim();
  if (!pin) return res.status(503).json({ ok: false, error: 'DASH_PIN 없음' });
  if (!safeEq(String(req.headers['x-pin'] || ''), pin)) return res.status(401).json({ ok: false, error: 'PIN 이 틀려요' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST 만' });
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const sym = String(b.sym || '').toUpperCase();
    const qty = Math.trunc(+b.qty), px = +b.px, ref = b.ref == null ? null : +b.ref, t = +b.t;
    if (!['SOXL', 'SOXS'].includes(sym) || !(qty > 0) || !(px > 0) || !(t > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.d || ''))) throw new Error('값 확인 (sym, qty, px, t, d)');
    const vars = await V.readAll();
    const S = JSON.parse(vars.MANUAL_STATE || '{}');
    const tr = { t, d: b.d, sym, qty, px, ref, pnl: ref ? qty * (px - ref) : null, why: String(b.why || '').slice(0, 60) };
    S.trades = (S.trades || []).filter(x => !(x.t === t && x.sym === sym && x.qty === qty && x.px === px));   // 같은 건 두 번 안 넣음
    S.trades.push(tr); S.trades.sort((a, c) => a.t - c.t);
    if (S.trades.length > 80) S.trades.splice(0, S.trades.length - 80);
    await V.write('MANUAL_STATE', JSON.stringify(S), 'MANUAL_STATE' in vars);
    return res.status(200).json({ ok: true, trade: tr, n: S.trades.length });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
}
