// api/_manual_core.js — 조건 주문 판단 로직 (브로커·저장소와 분리해 테스트 가능)
//
// MANUAL 변수 형식 (한 줄 = 한 규칙, # 뒤는 주석)
//   종목 BUY|SELL 수량 [진입조건] [필터] [청산]
//
// 진입조건 (BUY 에 하나)
//   IF<=65 / IF>=58      가격이 그 이하/이상이면 매수
//   NOW                  바로 매수
//   AT=11-04 23:30       한국시간 그 시각 이후 매수
//   PIT15M<20            15분봉 RSI14 가 20 아래까지 빠졌다가 30 을 다시 넘은 봉에서 매수 (5M, 1M, 30M, 60M 도 가능)
// 필터
//   TREND=UP / TREND=DN  전일 종가가 20일선 위 / 아래일 때만 진입
//   RTH                  정규장에서만 진입
//   REPEAT               끝나면 다음 거래일에 다시 대기 (하루 한 번)
//   RISK=700             손절 시 잃을 달러. 수량 = min(적은 수량, RISK ÷ 손절폭)
// 청산 (체결가 기준 자동 계산)
//   TP=72 | TP=+3% | TP=R1.5      익절가 / 체결가 +3% / 손절폭의 1.5배
//   SL=60 | SL=-2.5% | SL=LOW     손절가 / 체결가 -2.5% / 웅덩이 저점 -0.1% (PIT 일 때)
//   EXP=11-10                     그 미국 거래일 15:45 ET MOC 정리
//   EOD                           진입한 거래일 15:45 ET MOC 정리
// 예) SOXL BUY 500 PIT15M<20 TREND=UP RTH SL=LOW TP=R1 EOD RISK=1500 REPEAT
//     SOXS BUY 300 NOW TP=+3% SL=-2.5%
//     SOXS SELL 1000 TP=60 SL=48      ← 이미 가진 주식 (퍼센트는 평균단가 기준)

const N = '(\\d+(?:\\.\\d+)?)';
export function parseRules(text, year) {
  const rules = [];
  const errors = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim().replace(/\s+/g, ' ');
    if (!line) continue;
    const t = line.split(' ');
    const sym = (t[0] || '').toUpperCase();
    const side = (t[1] || '').toUpperCase();
    const qty = parseInt(t[2], 10);
    if (!/^[A-Z]{1,6}$/.test(sym) || !['BUY', 'SELL'].includes(side) || !(qty > 0)) {
      errors.push(`형식 오류: ${line}`); continue;
    }
    const r = { key: line, sym, side, qty, cond: null, tp: null, sl: null, exp: null, at: null, pit: null, trend: null, rth: false, repeat: false, eod: false, risk: null };
    let bad = false;
    for (let i = 3; i < t.length; i++) {
      const w = t[i].toUpperCase();
      let m;
      if ((m = w.match(new RegExp(`^IF(<=|>=)${N}$`)))) r.cond = { op: m[1], px: Number(m[2]) };
      else if (w === 'NOW') r.cond = { op: 'NOW' };
      else if ((m = w.match(/^PIT(\d{1,2})M(?:<(\d{1,2}))?$/))) {
        const mins = Number(m[1]);
        if (![1, 5, 15, 30, 60].includes(mins)) { errors.push(`PIT 분봉은 1·5·15·30·60: ${line}`); bad = true; }
        r.pit = { sec: mins * 60, depth: m[2] ? Number(m[2]) : 20 }; r.cond = { op: 'PIT' };
      }
      else if ((m = w.match(/^TREND=(UP|DN)$/))) r.trend = m[1];
      else if (w === 'RTH') r.rth = true;
      else if (w === 'REPEAT') r.repeat = true;
      else if (w === 'EOD') r.eod = true;
      else if ((m = w.match(new RegExp(`^RISK=\\$?${N}$`)))) r.risk = Number(m[1]);
      else if ((m = w.match(new RegExp(`^TP=${N}$`)))) r.tp = { k: 'abs', v: Number(m[1]) };
      else if ((m = w.match(new RegExp(`^TP=\\+${N}%$`)))) r.tp = { k: 'pct', v: Number(m[1]) };
      else if ((m = w.match(new RegExp(`^TP=R${N}$`)))) r.tp = { k: 'R', v: Number(m[1]) };
      else if ((m = w.match(new RegExp(`^SL=${N}$`)))) r.sl = { k: 'abs', v: Number(m[1]) };
      else if ((m = w.match(new RegExp(`^SL=-${N}%$`)))) r.sl = { k: 'pct', v: -Number(m[1]) };
      else if (w === 'SL=LOW') r.sl = { k: 'low' };
      else if ((m = w.match(/^EXP=(\d{1,2})-(\d{1,2})$/))) r.exp = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      else if ((m = w.match(/^AT=(\d{1,2})-(\d{1,2})$/)) && /^\d{1,2}:\d{2}$/.test(t[i + 1] || '')) {
        const [hh, mm] = t[i + 1].split(':');
        r.at = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}`; // KST
        r.cond = { op: 'AT' }; i++;
      } else { errors.push(`알 수 없는 항목 "${t[i]}": ${line}`); bad = true; }
    }
    if (bad) continue;
    const err = m => { errors.push(`${m}: ${line}`); bad = true; };
    if (side === 'BUY' && !r.cond) err('매수 조건(IF/AT/NOW/PIT) 없음');
    if (side === 'SELL' && !(r.tp || r.sl || r.exp || r.eod)) err('매도 조건(TP/SL/EXP) 없음');
    if (r.sl && r.sl.k === 'low' && !r.pit) err('SL=LOW 는 PIT 와 함께');
    if (r.tp && r.tp.k === 'R' && !r.sl) err('TP=R 은 SL 이 있어야');
    if (r.risk && !r.sl) err('RISK 는 SL 이 있어야');
    if (side === 'SELL' && (r.pit || r.risk || r.repeat)) err('SELL 에는 PIT/RISK/REPEAT 못 씀');
    if (bad) continue;
    rules.push(r);
  }
  return { rules, errors };
}

// ── 시각 ───────────────────────────────────────────────
function parts(d, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  const hour = Number(o.hour) % 24;
  return { date: `${o.year}-${o.month}-${o.day}`, wd: o.weekday, min: hour * 60 + Number(o.minute), hhmm: `${String(hour).padStart(2, '0')}:${o.minute}` };
}
const nextWeekday = (date) => {
  const d = new Date(date + 'T12:00:00Z');
  do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
};
export function clock(now = new Date()) {
  const et = parts(now, 'America/New_York');
  const kst = parts(now, 'Asia/Seoul');
  const wd = et.wd, m = et.min;
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd);
  let session = 'closed';
  if (weekday && m >= 4 * 60 && m < 9 * 60 + 30) session = 'pre';
  else if (weekday && m >= 9 * 60 + 30 && m < 16 * 60) session = 'regular';
  else if (weekday && m >= 16 * 60 && m < 20 * 60) session = 'after';
  else if ((['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].includes(wd) && m >= 20 * 60) || (weekday && m < 4 * 60)) session = 'day'; // 주간거래
  // 거래일: 20:00 ET 이후 주간거래는 다음 거래일 소속
  let tradeDate = et.date;
  if (m >= 20 * 60 || !weekday) tradeDate = nextWeekday(et.date);
  return { et, kst, session, tradeDate };
}
export { nextWeekday };

export const tick = p => Math.round(p * 100) / 100;

// ── 지표 ───────────────────────────────────────────────
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
// bars: 완성된 봉, 오래된 것 → 최신 {id, l, c}
// 마지막 봉에서 RSI 가 30 을 위로 넘었고, 그 직전 30 아래 구간(웅덩이)의 최저 RSI 가 depth 미만이면 신호
// RSI 가 백테스트와 같아지려면 100봉 이상 필요 (60봉이면 신호 35개 중 8개 어긋남)
export const MIN_BARS = 100;
export const barTime = id => new Date(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:${id.slice(10, 12)}:00+09:00`);
export function pitSignal(bars, depth = 20) {
  if (!bars || bars.length < MIN_BARS) return { fire: false, short: true, n: bars ? bars.length : 0 };
  const R = rsi(bars.map(b => b.c));
  const i = bars.length - 1;
  const rsiNow = R[i];
  if (!(R[i] >= 30 && R[i - 1] !== null && R[i - 1] < 30)) return { fire: false, rsi: rsiNow };
  let j = i - 1, mn = 100, low = Infinity;
  while (j >= 0 && R[j] !== null && R[j] < 30) { mn = Math.min(mn, R[j]); low = Math.min(low, bars[j].l); j--; }
  return { fire: mn < depth, id: bars[i].id, min: mn, low, rsi: rsiNow };
}
// days: 일봉, 최신 → 오래된 {date:'YYYY-MM-DD', c}. tradeDate 이전 봉만 사용
export function trendOf(days, tradeDate) {
  const done = (days || []).filter(d => d.date < tradeDate).slice(0, 20);
  if (done.length < 20) return null;
  const ma = done.reduce((s, d) => s + d.c, 0) / 20;
  return { up: done[0].c > ma, prev: done[0].c, ma };
}

// ── 청산가 계산 ─────────────────────────────────────────
export function levels(r, entry, pitLow) {
  let sl = null, tp = null;
  if (r.sl) {
    if (r.sl.k === 'abs') sl = r.sl.v;
    else if (r.sl.k === 'pct') sl = entry * (1 + r.sl.v / 100);
    else if (r.sl.k === 'low' && pitLow > 0) sl = pitLow * 0.999;
    // 매수 규칙에서 손절이 체결가 위면 -1% 로 (사자마자 손절 방지). 보유분 SELL 의 직접 지정 손절은 평단 위(본전·이익 보호)라도 그대로
    if (sl !== null && sl >= entry && (r.sl.k === 'low' || r.side === 'BUY')) sl = entry * 0.99;
    if (sl !== null) sl = tick(sl);
  }
  if (r.tp) {
    if (r.tp.k === 'abs') tp = r.tp.v;
    else if (r.tp.k === 'pct') tp = entry * (1 + r.tp.v / 100);
    else if (r.tp.k === 'R' && sl !== null && sl < entry) tp = entry + r.tp.v * (entry - sl);
  }
  return { sl: sl === null ? null : tick(sl), tp: tp === null ? null : tick(tp) };
}

// ── 한 단계 판단 (실제 주문은 핸들러) ───────────────────
// st: { st:'wait'|'buying'|'hold'|'selling'|'done', bought, sold, cost, tpPx, slPx, expDate, exiting, lastSig }
// ctx: { px, clk, slip, sig, trend }
export function decide(r, st, ctx) {
  const { px, clk, slip } = ctx;
  const held = (st.bought || 0) - (st.sold || 0);
  const exp = r.exp || st.expDate || null;
  const closing = clk.session === 'regular' && clk.et.min >= 15 * 60 + 45;
  const expPassed = exp && clk.tradeDate > exp;
  const expToday = exp && clk.tradeDate === exp;
  if (st.ord) return { act: 'WAIT_ORDER' };
  if (st.st === 'wait') {
    if (r.exp && (clk.tradeDate > r.exp || (clk.tradeDate === r.exp && closing))) return { act: 'EXPIRE', why: '만기까지 매수 조건 안 옴' };
    if (r.rth && clk.session !== 'regular') return { act: 'NONE' };
    if (r.eod && closing) return { act: 'NONE' }; // 마감 직전엔 새로 안 들어감
    if (r.trend) {
      if (!ctx.trend) return { act: 'NONE', why: '추세 판단 불가' };
      if ((r.trend === 'UP') !== ctx.trend.up) return { act: 'NONE' };
    }
    let ok = false, why = '';
    const op = r.cond.op;
    if (op === 'NOW') { ok = true; why = '즉시'; }
    else if (op === '<=') { ok = px <= r.cond.px; why = `가격 ${px} <= ${r.cond.px}`; }
    else if (op === '>=') { ok = px >= r.cond.px; why = `가격 ${px} >= ${r.cond.px}`; }
    else if (op === 'AT') { ok = `${clk.kst.date}T${clk.kst.hhmm}` >= r.at; why = `시각 ${r.at}`; }
    else if (op === 'PIT') {
      const s = ctx.sig;
      ok = !!(s && s.fire && s.id !== st.lastSig);
      if (ok) why = `${r.pit.sec / 60}분 RSI 웅덩이 ${s.min.toFixed(1)} → ${s.rsi.toFixed(1)}`;
    }
    if (!ok) return { act: 'NONE' };
    const lim = op === '<=' ? Math.min(tick(px * (1 + slip)), tick(r.cond.px * (1 + slip))) : tick(px * (1 + slip));
    let qty = r.qty - (st.bought || 0);
    if (r.risk) {
      const lv = levels(r, px, ctx.sig && ctx.sig.low);
      const per = lv.sl !== null ? px - lv.sl : 0;
      if (per > 0) qty = Math.min(qty, Math.floor(r.risk / per));
    }
    if (qty <= 0) return { act: 'NONE', why: 'RISK 로 계산한 수량 0' };
    return { act: 'BUY', qty, kind: 'LIMIT', px: lim, why, pitLow: ctx.sig && ctx.sig.low, sigId: ctx.sig && ctx.sig.id };
  }
  if (st.st === 'hold') {
    if (held <= 0) return { act: 'DONE' };
    if (st.exiting) return { act: 'SELL', qty: held, kind: 'LIMIT', px: tick(px * (1 - 2 * slip)), why: `${st.exiting} (이어서)` };
    if (exp && (expPassed || (expToday && closing))) {
      if (expToday && clk.session === 'regular' && clk.et.min < 15 * 60 + 50) return { act: 'SELL', qty: held, kind: 'MOC', px: 0, why: `만기 ${exp} MOC` };
      return { act: 'SELL', qty: held, kind: 'LIMIT', px: tick(px * (1 - 2 * slip)), why: `만기 ${exp} 지남` };
    }
    const tp = st.tpPx ?? (r.tp && r.tp.k === 'abs' ? r.tp.v : null);
    const sl = st.slPx ?? (r.sl && r.sl.k === 'abs' ? r.sl.v : null);
    if (tp && px >= tp) return { act: 'SELL', qty: held, kind: 'LIMIT', px: tick(px * (1 - slip)), why: `익절 ${px} ≥ ${tp}` };
    if (sl && px <= sl) return { act: 'SELL', qty: held, kind: 'LIMIT', px: tick(px * (1 - 2 * slip)), why: `손절 ${px} ≤ ${sl}` };
    return { act: 'NONE' };
  }
  return { act: 'NONE' };
}
