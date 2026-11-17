// api/cron-night.js — 계좌1 밤 돌파 (스나이퍼가 안 쓰는 현금으로 종가 매수 → 다음 날 아침 매도), Vercel Cron 1분마다
//
// 규칙은 _night_core.js 맨 위.
// 계좌1 (스나이퍼 계좌) 키를 그대로 쓴다: MERITZ_APP_KEY, MERITZ_APP_SECRET · 토큰 캐시는 조건주문 봇과 같은 MANUAL_TOKEN 공유
// 산 주식은 EXTRA_SHARES 에 더하고 팔면 뺀다 → 스나이퍼 장부 대조가 어긋나지 않음
//
// GitHub Variables (sniper-bot 저장소)
//   NIGHT_MODE       OFF | PAPER | LIVE   (없으면 OFF)   PAPER = 신호·수량만 알림, 주문 안 냄
//   NIGHT_SLIP       지정가 여유폭 (기본 0.005)
//   NIGHT_STOP_SLIP  밤사이 손절 지정가 여유폭 (기본 0.01)
//   NIGHT_WAIT_MIN   매도 지정가 미체결 시 취소까지 분 (기본 1)
//   NIGHT_CASH_FLOOR 계좌에 남겨둘 달러 (기본 0)
//   NIGHT_STATE      봇 상태 (건드리지 않기)
import crypto from 'node:crypto';
import * as M from './_meritz.js';
import * as V from './_ghvars.js';
import { clock, tick } from './_manual_core.js';
import { nightPlan, nightFire, nightBudget, nightStop } from './_night_core.js';

const SYM = 'SOXL';
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;

function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
async function tg(text) {
  const t = process.env.TG_TOKEN, c = process.env.TG_CHAT;
  if (!t || !c) return;
  try {
    await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: c, text: text.slice(0, 3900) }),
    });
  } catch { /* 무시 */ }
}

// ── 야후 시세 ──────────────────────────────────────────
const ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function etOf(sec) {
  const o = {}; for (const p of ETF.formatToParts(new Date(sec * 1000))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, min: (Number(o.hour) % 24) * 60 + Number(o.minute) };
}
async function yahoo(sym, interval, range, prepost = false) {
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
  let last = '';
  for (const host of ['query1', 'query2']) {
    try {
      const u = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=${prepost}`;
      const r = await fetch(u, { headers: UA });
      if (r.status !== 200) { last = `HTTP${r.status}`; continue; }
      const j = await r.json();
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res || !res.timestamp) { last = '데이터 없음'; continue; }
      const q = res.indicators.quote[0], out = [];
      res.timestamp.forEach((t, i) => {
        const c = q.close[i];
        if (!(c > 0)) return;
        const e = etOf(t);
        out.push({ t, date: e.date, min: e.min, o: q.open[i] || c, h: q.high[i] || c, l: q.low[i] || c, c });
      });
      return out;
    } catch (e) { last = e.message; }
  }
  throw new Error(`야후 ${sym} ${interval} 실패: ${last}`);
}

// ── 한 번 실행 ─────────────────────────────────────────
export async function runOnce({ vars, broker, now = new Date(), notify = tg, saveVar, mkt = { yahoo } }) {
  const clk = clock(now), et = clk.et, ses = clk.session;
  const mode = String(vars.NIGHT_MODE || 'OFF').trim().toUpperCase();
  const slip = num(vars.NIGHT_SLIP, 0.005), stopSlip = num(vars.NIGHT_STOP_SLIP, 0.01);
  const waitMs = num(vars.NIGHT_WAIT_MIN, 1) * 60000;
  const floor = num(vars.NIGHT_CASH_FLOOR, 0);
  const live = mode === 'LIVE';
  const tag = live ? '🌙[계좌1 밤돌파] ' : '🌙[계좌1 밤돌파 PAPER] ';
  let S; try { S = JSON.parse(vars.NIGHT_STATE || '{}'); } catch { S = {}; }
  const say = [], log = [];
  const save = () => saveVar('NIGHT_STATE', JSON.stringify(S));

  if (mode !== 'LIVE' && mode !== 'PAPER') return { log: ['OFF'] };
  if (S.mode && S.mode !== mode) {
    if (S.pos && S.pos.qty > 0 && S.mode === 'LIVE') { say.push(`${tag}⚠️ LIVE 보유 ${S.pos.qty}주가 있는데 모드가 ${mode} 로 바뀜 → 그대로 두고 직접 정리하세요 (EXTRA_SHARES 확인)`); }
    S = { mode };
  }
  S.mode = mode;
  if (ses === 'closed') return { log: ['장 닫힘'] };
  if (S.lock && now.getTime() - S.lock < 50000) return { log: ['잠금 중'] };
  S.lock = now.getTime(); await save();

  const extra = async delta => {           // 스나이퍼 장부 밖 주식 수 맞추기 (LIVE 만)
    if (!live || !delta) return;
    const cur = Number(vars.EXTRA_SHARES || 0);
    try { await saveVar('EXTRA_SHARES', String(cur + delta)); say.push(`${tag}ℹ️ EXTRA_SHARES ${cur} → ${cur + delta}`); }
    catch (e) { say.push(`${tag}⚠️ EXTRA_SHARES 갱신 실패 (${cur}→${cur + delta}) 직접 고쳐주세요: ${e.message}`); }
  };
  const filledQty = async ord => {
    const rows = await broker.ordersToday();
    const row = rows.find(x => String(x.oder_no) === String(ord.no) && String(x.oder_rctf_cncl_cls_code || '0') === '0');
    return { row, filled: row ? Number(row.cntg_qty || 0) : 0 };
  };

  try {
    // 1) 걸려 있는 주문 확인
    if (S.order) {
      const o = S.order;
      if (o.side === 'BUY') {
        // 종가 매수는 장 끝난 뒤 체결 수량 확인
        if (ses === 'regular') { log.push('종가 매수 대기'); return finish(); }
        const { filled } = await filledQty(o);
        S.order = null;
        if (filled > 0) {
          S.pos.qty = filled; S.pos.cost = filled * (o.px || 0);
          await extra(filled);
          say.push(`${tag}✅ 종가 매수 체결 ${filled}주${filled < o.qty ? ` (주문 ${o.qty}주)` : ''} → 내일 아침 매도`);
        } else { say.push(`${tag}ℹ️ 종가 매수 체결 안 됨 → 오늘 끝`); S.pos = null; }
        return finish();
      }
      // 매도 지정가
      if (now.getTime() - o.at < waitMs) { log.push('매도 대기'); return finish(); }
      const { row, filled } = await filledQty(o);
      const rest = o.qty - filled;
      if (row && rest > 0) { try { await broker.cancel({ no: o.no, cls: o.cls, date: row.oder_date }, rest); } catch (e) { log.push(`취소 실패 ${e.message}`); } }
      S.order = null;
      if (filled > 0) {
        S.pos.qty -= filled; S.pos.proceeds = (S.pos.proceeds || 0) + filled * o.px;
        await extra(-filled);
      }
      if (S.pos.qty <= 0) return done();
      log.push(`매도 남은 ${S.pos.qty}주 → 다음 분에 다시`); return finish();
    }

    // 2) 오늘 종가 매수 판단 — 15:46~15:49 는 MOC (정확히 종가), 그 뒤 15:56~15:58 에 처음 돌파한 날은 지정가
    const moc = et.min >= 15 * 60 + 46 && et.min < 15 * 60 + 50;
    const late = et.min >= 15 * 60 + 56 && et.min < 15 * 60 + 59;
    if (ses === 'regular' && !S.pos && (moc || late) && (S.day || {}).date !== et.date + (moc ? 'M' : 'L')) {
      S.day = { date: et.date + (moc ? 'M' : 'L') };
      const today = (await mkt.yahoo(SYM, '1m', '1d', false)).filter(b => b.date === et.date && b.min >= 570);
      if (!today.length || today[today.length - 1].min < et.min - 5) { log.push('오늘 장 데이터 없음 (휴장·조기폐장)'); return finish(); }
      const open = today[0].o, high = Math.max(...today.map(b => b.h));
      const sd = (await mkt.yahoo(SYM, '1d', '1y')).filter(b => b.date < et.date);
      const nqd = await mkt.yahoo('NQ=F', '1d', '2y');
      const nqC = nqd.filter(b => b.date < et.date).map(b => b.c);
      const nqNow = (await mkt.yahoo('NQ=F', '1m', '1d', true)).pop()?.c || 0;
      const pl = nightPlan(sd, nqC, nqNow);
      const f = nightFire(pl, open, high);
      if (moc) S.planMsg = pl.ok ? `시가 ${fmt(open)} + ${pl.k} × 전일진폭 ${fmt(pl.rng)} = ${fmt(f.level)} (고가 ${fmt(high)})` : pl.why;
      if (f.fire) {
        const px = await broker.price(SYM, 'regular');
        const cash = Math.max(0, (await broker.cash()) - floor);
        const hd = await broker.holdings();
        const eq = cash + ((hd[SYM] && hd[SYM].qty) || 0) * px;
        const q = Math.floor(nightBudget(cash, eq, pl.w) / (px * (1 + slip)));
        const head = `${tag}🌙 밤 돌파 (${pl.fastUp ? 'NQ 20일선 위, 비중 100%' : 'NQ 20일선 아래, 비중 50%'}) 돌파가 ${fmt(f.level)} · 고가 ${fmt(high)} · 현재 ${fmt(px)}`;
        if (q <= 0) { say.push(`${head}\n   남는 현금 없음 ($${fmt(cash)}) → 쉼`); return finish(); }
        if (live) {
          const kind = moc ? 'MOC' : 'LIMIT', lim = moc ? 0 : tick(px * (1 + slip));
          const o = await broker.order('BUY', SYM, q, kind, lim);
          S.order = { no: o.no, cls: o.cls, side: 'BUY', qty: q, px, at: now.getTime() };
          S.pos = { date: et.date, qty: 0, nq0: null, stopHit: false };
          say.push(`${head}\n   📤 ${q}주 ${moc ? '종가(MOC)' : '지정가 ' + fmt(lim)} 매수 · 남는 현금 $${fmt(cash)} · #${o.no}`);
        } else {
          S.pos = { date: et.date, qty: q, cost: q * px * 1.0005, nq0: null, stopHit: false };
          say.push(`${head}\n   🟢 (가상) ${q}주 종가 매수 · 남는 현금 $${fmt(cash)}`);
        }
      } else if (moc) log.push(`신호 없음: ${S.planMsg}`);
    }

    // 3) 밤사이 손절 감시 (산 날 16:00 이후 ~ 다음 날 정규장 전)
    let want = false, why = '', sellSlip = slip;
    if (S.pos && S.pos.qty > 0 && ses !== 'regular') {
      if (!S.pos.nq0) {
        const b = (await mkt.yahoo('NQ=F', '1m', '5d', true)).filter(x => x.date === S.pos.date && x.min <= 15 * 60 + 59).pop();
        if (b) S.pos.nq0 = b.c;
      }
      if (S.pos.nq0 && !S.pos.stopHit) {
        const nqNow = (await mkt.yahoo('NQ=F', '1m', '1d', true)).pop()?.c || 0;
        if (nightStop(S.pos.nq0, nqNow)) { S.pos.stopHit = true; say.push(`${tag}🛑 밤사이 손절: NQ ${fmt(nqNow)} (기준 ${fmt(S.pos.nq0)}, ${pct(nqNow / S.pos.nq0 - 1)})`); }
      }
      if (S.pos.stopHit) { want = true; why = 'NQ 밤사이 손절'; sellSlip = stopSlip; }
    }
    // 4) 다음 날 프리장 9:28 매도 → 안 팔리면 정규장 시가
    if (S.pos && S.pos.qty > 0 && S.pos.date !== et.date) {
      if (ses === 'pre' && et.min >= 9 * 60 + 28) { want = true; why = why || '프리장 9:28 매도'; sellSlip = Math.min(sellSlip, 0.003); }
      if (ses === 'regular') { want = true; why = why || '다음 날 시가 매도'; }
    }
    if (want) {
      let px;
      if (ses === 'pre') { const b = await mkt.yahoo(SYM, '1m', '1d', true); px = b.length ? b[b.length - 1].c : 0; }
      else px = await broker.price(SYM, ses);
      if (!(px > 0)) throw new Error(`${ses} 가격 없음`);
      let q = S.pos.qty;
      if (live) {
        const h = (await broker.holdings())[SYM];
        const sellable = h ? (h.sellable ?? h.qty) : 0;
        q = Math.min(q, sellable);
        if (q <= 0) { if (!S.pos.sellWarn) say.push(`${tag}⚠️ 매도가능 0주 → 확인 필요`); S.pos.sellWarn = 1; return finish(); }
        const lim = tick(px * (1 - sellSlip));
        const o = await broker.order('SELL', SYM, q, 'LIMIT', lim);
        S.order = { no: o.no, cls: o.cls, side: 'SELL', qty: q, px: lim, at: now.getTime() };
        say.push(`${tag}📤 매도 ${q}주 지정가 ${fmt(lim)} (현재 ${fmt(px)}) · ${why} · ${ses} · #${o.no}`);
      } else {
        S.pos.proceeds = q * px * 0.9995; S.pos.qty = 0;
        say.push(`${tag}🔴 (가상) 매도 ${q}주 @${fmt(px)} · ${why}`);
        return done();
      }
    }
  } catch (e) {
    const m = `${e.message}`.slice(0, 200);
    if (S.errMsg !== m) say.push(`${tag}❌ 오류: ${m}`);
    S.errMsg = m; log.push(m);
  }
  return finish();

  async function done() {
    const p = S.pos;
    if (p && p.cost > 0) {
      const pl = (p.proceeds || 0) - p.cost;
      S.tot = (S.tot || 0) + pl; S.n = (S.n || 0) + 1; S.win = (S.win || 0) + (pl > 0 ? 1 : 0);
      say.push(`${tag}🏁 손익 ${pl >= 0 ? '+' : ''}$${fmt(pl)} (${pct(pl / p.cost)}) · 누적 ${S.tot >= 0 ? '+' : ''}$${fmt(S.tot)} (${S.n}회, 승 ${S.win})`);
    } else say.push(`${tag}🏁 정리 끝`);
    S.pos = null;
    return finish();
  }
  async function finish() {
    S.lock = 0;
    S.last = `${clk.kst.date} ${clk.kst.hhmm} KST ${ses}`;
    await save();
    if (say.length) await notify(say.join('\n'));
    return { log, say, S };
  }
}

// ── 메리츠 연결 (계좌1 키, 조건주문 봇과 같은 토큰 캐시) ─────────
const KEY = () => crypto.createHash('sha256').update('manual-token:' + (process.env.CRON_SECRET || '')).digest();
function seal(obj) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function open_(s) {
  try {
    const [iv, tag, enc] = String(s).split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY(), iv); d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  } catch { return null; }
}
let MEM = null;
function liveBroker(vars, saveVar) {
  const ensure = async (force) => {
    if (!force && MEM && MEM.exp > Date.now()) return MEM;
    if (!force && vars.MANUAL_TOKEN) { const c = open_(vars.MANUAL_TOKEN); if (c && c.exp > Date.now()) return (MEM = c); }
    MEM = await M.issueToken();
    try { await saveVar('MANUAL_TOKEN', seal(MEM)); } catch { /* 무시 */ }
    return MEM;
  };
  const w = fn => async (...a) => {
    try { return await fn(await ensure(false), ...a); }
    catch (e) { if (e.code === 'TOKEN_DEAD') return fn(await ensure(true), ...a); throw e; }
  };
  return {
    price: w((t, s, ses) => M.price(t, s, ses)),
    holdings: w(t => M.holdings(t)),
    ordersToday: w(t => M.ordersToday(t)),
    cash: w(t => M.cashUSD(t)),
    order: w((t, side, s, q, k, p) => M.order(t, side, s, q, k, p)),
    cancel: w((t, o, q) => M.cancel(t, o, q)),
  };
}

export default async function handler(req, res) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!(secret.length >= 16 && safeEq(String(req.headers['authorization'] || ''), `Bearer ${secret}`)))
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  let vars;
  try { vars = await V.readAll(); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  const saveVar = (n, v, exists = n in vars) => V.write(n, v, exists).then(() => { vars[n] = String(v); });
  try {
    const out = await runOnce({ vars, broker: liveBroker(vars, saveVar), saveVar });
    return res.status(200).json({ ok: true, log: out.log, say: out.say });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
