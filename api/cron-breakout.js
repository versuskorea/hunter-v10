// api/cron-breakout.js — SOXL 돌파 봇 (새 메리츠 계좌 전용, Vercel Cron 1분마다)
//
// 규칙은 _bo_core.js 맨 위. 이 계좌의 SOXL 은 전부 봇 몫으로 본다 (다른 매매 금지).
//
// Vercel 환경변수: MERITZ2_APP_KEY, MERITZ2_APP_SECRET (새 계좌), CRON_SECRET, GH_TOKEN, TG_TOKEN, TG_CHAT
// GitHub Variables (sniper-bot 저장소)
//   BO_MODE        OFF | PAPER | LIVE   (없으면 PAPER = 모의, 주문 안 냄)
//   BO_PAPER_CASH  PAPER 시작 달러 (기본 100000)
//   BO_SLIP        매수·시가매도 지정가 여유폭 (기본 0.005)
//   BO_STOP_SLIP   밤사이 손절 지정가 여유폭 (기본 0.01)
//   BO_WAIT_MIN    지정가 미체결 시 취소까지 분 (기본 1)
//   BO_STATE       봇 상태 (건드리지 않기) · BO_TOKEN 메리츠 토큰 캐시 (암호화)
import crypto from 'node:crypto';
import * as M from './_meritz.js';
import * as V from './_ghvars.js';
import { clock, tick } from './_manual_core.js';
import { plan as makePlan, arm, stopHit, sxPlan, PX, ddMult } from './_bo_core.js';

const SYM = 'SOXL', SX = 'SOXS';
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function runOnce({ vars, broker, now = new Date(), notify = tg, saveVar, mkt = { yahoo, sleep } }) {
  const clk = clock(now), et = clk.et, ses = clk.session;
  const mode = String(vars.BO_MODE || 'PAPER').toUpperCase();
  const slip = num(vars.BO_SLIP, 0.005), stopSlip = num(vars.BO_STOP_SLIP, 0.01);
  const waitMs = num(vars.BO_WAIT_MIN, 1) * 60000;
  const acct = String(vars.BO_ACCOUNT || '계좌2 돌파').trim();
  const tag = mode === 'LIVE' ? `🚀[${acct}] ` : `🚀[${acct} PAPER] `;
  let S; try { S = JSON.parse(vars.BO_STATE || '{}'); } catch { S = {}; }
  const say = [], log = [];
  const save = () => saveVar('BO_STATE', JSON.stringify(S));

  if (mode === 'OFF') { log.push('OFF'); return { log }; }
  if (S.mode && S.mode !== mode) { say.push(`${tag}모드 ${S.mode} → ${mode}: 포지션 기록 초기화`); S = {}; }
  S.mode = mode;
  if (S.lock && now.getTime() - S.lock < 50000) return { log: ['잠금 중'] };
  if (ses === 'closed') { S.last = `${clk.kst.date} ${clk.kst.hhmm} KST closed`; return { log: ['장 닫힘'] }; }
  S.lock = now.getTime(); await save();
  let qty = 0, cash = 0, sq = 0, mult = 1;

  try {
    // 1) 계좌
    if (mode === 'LIVE') {
      const hd = await broker.holdings(); qty = (hd[SYM] && hd[SYM].qty) || 0; sq = (hd[SX] && hd[SX].qty) || 0; cash = await broker.cash();
    } else {
      if (!S.paper) S.paper = { cash: num(vars.BO_PAPER_CASH, 100000), qty: 0, start: num(vars.BO_PAPER_CASH, 100000) };
      qty = S.paper.qty; sq = S.paper.sq || 0; cash = S.paper.cash;
    }
    if (!S.sx) S.sx = {};
    // 계좌 고점 (포지션 없을 때 현금 = 자산) → 고점 대비 −20% 아래면 새 매수 절반
    if (qty === 0 && sq === 0 && !S.order && !S.sx.order) S.peakEq = Math.max(S.peakEq || 0, cash);
    mult = ddMult(S.lastFlatEq = (qty === 0 && sq === 0 ? cash : (S.lastFlatEq || cash)), S.peakEq || cash);
    if (S.lastQty !== undefined && qty !== S.lastQty && mode === 'LIVE') {
      say.push(`${tag}✅ ${SYM} ${qty > S.lastQty ? '매수' : '매도'} 체결 ${Math.abs(qty - S.lastQty)}주 → 보유 ${qty}주`);
    }
    S.lastQty = qty;

    // 봇 기록 없는 SOXL 이 있으면 손대지 않는다
    if (!S.pos && qty > 0 && S.want == null) {
      if (S.foreignWarn !== et.date) say.push(`${tag}⚠️ 계좌에 봇 기록 없는 ${SYM} ${qty}주 → 매매 보류. 이 계좌는 돌파 전용으로 비워주세요`);
      S.foreignWarn = et.date; return finish();
    }

    // 2) 미체결 주문 처리 (LIVE)
    if (S.order) {
      if (now.getTime() - S.order.at < waitMs) { log.push('주문 대기'); return finish(); }
      try {
        const rows = await broker.ordersToday();
        const row = rows.find(x => String(x.oder_no) === String(S.order.no) && String(x.oder_rctf_cncl_cls_code || '0') === '0');
        const rest = row ? S.order.qty - Number(row.cntg_qty || 0) : 0;
        if (row && rest > 0) await broker.cancel({ no: S.order.no, cls: S.order.cls, date: row.oder_date }, rest);
      } catch (e) { log.push(`취소 실패(체결됐을 수 있음) ${e.message}`); }
      S.order = null; log.push('미체결 취소 → 다음 분에 다시'); return finish();
    }

    // 3) 오늘 계획 (프리장·정규장, 하루 한 번)
    const weekday = !['Sat', 'Sun'].includes(et.wd);
    if (weekday && (ses === 'pre' || ses === 'regular') && (!S.plan || S.plan.date !== et.date)) {
      const sd = (await mkt.yahoo(SYM, '1d', '1y')).filter(b => b.date < et.date);
      const nd = (await mkt.yahoo('NQ=F', '1d', '2y')).filter(b => b.date < et.date).map(b => b.c);
      const pl = makePlan(sd, nd);
      S.plan = { date: et.date, status: pl.mode === 'skip' ? 'skip' : 'wait', ...pl };
      const head = `${tag}📋 ${et.date} 계획: `;
      if (pl.mode === 'skip') say.push(`${head}쉼 — ${pl.why}`);
      else say.push(`${head}${pl.mode === 'atk' ? '공격' : '수비'} (NQ ${pl.nqUp ? '200일선 위' : '200일선 아래'}, RSI ${pl.rsi.toFixed(1)}, 전일 ${pct(pl.prevret)})\n   돌파가 = 시가 + ${pl.k} × ATR5 ${fmt(pl.atr)} · 비중 ${pl.w * 100}% · 밤사이 손절 NQ −${pl.stop * 100}%`);
    }

    let want = S.want ?? null, why = '', sellSlip = slip;

    // 4) 정규장
    if (ses === 'regular') {
      // 4-1) 전날 산 것 → 시가 매도
      if (S.pos && S.pos.date !== et.date && qty > 0) { want = 0; why = '다음 날 시가 매도'; }
      // 4-2) 돌파 매수
      const pl = S.plan;
      if (pl && pl.date === et.date && pl.status === 'wait' && !S.pos && et.min >= 9 * 60 + 30 && et.min < 15 * 60 + 58) {
        if (!(pl.level > 0)) {
          const bars = await mkt.yahoo(SYM, '1m', '1d', true);
          const today = bars.filter(b => b.date === et.date);
          const first = today.find(b => b.min >= 570);
          const pre = today.filter(b => b.min < 570);
          if (first) {
            Object.assign(pl, arm(pl, first.o, pre.length ? pre[pre.length - 1].c : 0));
            if (pl.mode === 'skip') { pl.status = 'skip'; say.push(`${tag}⏸ 오늘 쉼 — ${pl.why}`); }
            else say.push(`${tag}🎯 시가 ${fmt(pl.open)} · 프리장 ${pct(pl.pm)} → 돌파가 ${fmt(pl.level)}`);
          }
        }
        if (pl.status === 'wait' && pl.level > 0) {
          const bars = (await mkt.yahoo(SYM, '1m', '1d', false)).filter(b => b.date === et.date && b.min >= 570);
          const hi = Math.max(...bars.map(b => b.h), 0);
          let px = await broker.price(SYM, 'regular');
          // 장 시작 6분(23:30~23:36 KST)은 공격 돌파의 3분의 1이 몰리는 구간 → 2초마다 확인 (그 분의 45초까지, 함수 제한 50초 안)
          if (!(hi >= pl.level || px >= pl.level) && et.min < 9 * 60 + 36) {
            const deadline = Math.floor(now.getTime() / 60000) * 60000 + 45000;
            const t0 = Date.now(), until = t0 + Math.max(0, deadline - now.getTime());
            while (Date.now() < until) {
              await (mkt.sleep || sleep)(2000);
              px = await broker.price(SYM, 'regular');
              if (px >= pl.level) { log.push(`빠른 확인으로 돌파 ${px}`); break; }
            }
          }
          if (hi >= pl.level || px >= pl.level) {
            const eq = cash + qty * px;
            const q = Math.floor((pl.w * mult * eq) / (px * (1 + slip)));
            if (mult < 1) log.push('계좌 고점 −20% 아래 → 비중 절반');
            pl.status = 'entered';
            if (q > 0) {
              S.pos = { date: et.date, qty: q, entry: px, stop: pl.stop, mode: pl.mode, nq0: null, stopHit: false, cost: 0 };
              want = q; why = `돌파 (${fmt(pl.level)} 돌파, 고가 ${fmt(hi)})`;
            } else say.push(`${tag}⚠️ 돌파했지만 현금 부족 ($${fmt(cash)})`);
          }
        }
      }
    }

    // 5) 밤사이 손절 감시 (매수한 날 16:00 이후 ~ 다음 날 정규장 전)
    if (S.pos && qty > 0 && ses !== 'regular') {
      if (!S.pos.nq0) {
        const nb = await mkt.yahoo('NQ=F', '1m', '5d', true);
        const b = nb.filter(x => x.date === S.pos.date && x.min <= 15 * 60 + 59).pop();
        if (b) { S.pos.nq0 = b.c; log.push(`NQ 기준 ${b.c}`); }
      }
      if (S.pos.nq0 && !S.pos.stopHit) {
        const nb = await mkt.yahoo('NQ=F', '1m', '1d', true);
        const nqNow = nb.length ? nb[nb.length - 1].c : 0;
        if (stopHit(S.pos.nq0, nqNow, S.pos.stop)) {
          S.pos.stopHit = true;
          say.push(`${tag}🛑 밤사이 손절: NQ ${fmt(nqNow)} (기준 ${fmt(S.pos.nq0)}, ${pct(nqNow / S.pos.nq0 - 1)})`);
        }
      }
      if (S.pos.stopHit) { want = 0; why = 'NQ 밤사이 손절'; sellSlip = stopSlip; }
    }

    // 5-1) 다음 날 프리장 9:28(한국 23:28)에 미리 매도 — 장 시작 직후 출렁임 피하기. 안 팔린 건 9:30 이후 시가 매도로 이어짐
    if (S.pos && qty > 0 && S.pos.date !== et.date && ses === 'pre' && et.min >= 9 * 60 + 28) { want = 0; why = '프리장 9:28 매도'; sellSlip = Math.min(sellSlip, 0.003); }

    // 6) 목표 수량으로 맞추기
    if (want !== null) S.want = want;
    if (S.want !== null && S.want !== undefined && S.want !== qty) {
      const side = S.want > qty ? 'BUY' : 'SELL';
      let q = Math.abs(S.want - qty);
      let px;
      if (ses === 'day') px = await broker.price(SYM, 'day');
      else if (ses === 'after') px = await broker.price(SYM, 'after');
      else if (ses === 'pre') { const b = await mkt.yahoo(SYM, '1m', '1d', true); px = b.length ? b[b.length - 1].c : 0; }
      else px = await broker.price(SYM, 'regular');
      if (!(px > 0)) throw new Error(`${ses} 가격 없음`);
      const lim = tick(side === 'BUY' ? px * (1 + slip) : px * (1 - sellSlip));
      if (side === 'BUY') {
        q = Math.min(q, Math.floor(cash / lim));
        // 정규장 밖이거나 돌파가보다 3% 넘게 올라가 버렸으면 남은 매수는 포기 (쫓아가지 않음)
        const lv = S.plan && S.plan.level;
        if (ses !== 'regular' || et.min >= 15 * 60 + 58 || (lv > 0 && px > lv * 1.03)) {
          if (qty > 0) say.push(`${tag}ℹ️ 매수 ${qty}/${S.want}주에서 멈춤 (현재 ${fmt(px)}) · 이 수량으로 진행`);
          else { say.push(`${tag}ℹ️ 매수 못 함 (현재 ${fmt(px)}, 돌파가 ${fmt(lv)}) · 오늘 끝`); S.pos = null; }
          S.want = qty > 0 ? qty : null; if (S.pos) S.pos.qty = qty; q = 0;
        }
      }
      if (q > 0) {
        if (mode === 'LIVE') {
          const o = await broker.order(side, SYM, q, 'LIMIT', lim);
          S.order = { no: o.no, cls: o.cls, side, qty: q, at: now.getTime() };
          say.push(`${tag}📤 ${SYM} ${side === 'BUY' ? '매수' : '매도'} ${q}주 지정가 ${fmt(lim)} (현재 ${fmt(px)}) · ${why || '이어서'} · ${ses} · #${o.no}`);
        } else {
          const fill = side === 'BUY' ? px * (1 + 0.0005) : px * (1 - 0.0005);
          if (side === 'BUY') { S.paper.cash -= q * fill; S.paper.qty += q; S.pos.cost = (S.pos.cost || 0) + q * fill; S.pos.entry = fill; }
          else { S.paper.cash += q * fill; S.paper.qty -= q; if (S.pos) S.pos.proceeds = (S.pos.proceeds || 0) + q * fill; }
          qty = S.paper.qty; S.lastQty = qty;
          say.push(`${tag}${side === 'BUY' ? '🟢 매수' : '🔴 매도'} ${q}주 @${fmt(fill)} (가상) · ${why} · ${ses}`);
        }
      }
    }

    // 7) 포지션 끝
    if (S.pos && S.want === 0 && qty === 0 && !S.order) {
      if (mode !== 'LIVE' && S.pos.cost) {
        const pl = (S.pos.proceeds || 0) - S.pos.cost;
        const eq = S.paper.cash;
        say.push(`${tag}🏁 끝 손익 ${pl >= 0 ? '+' : ''}$${fmt(pl)} (${pct(pl / S.pos.cost)}) · 가상자산 $${fmt(eq)} (시작 대비 ${pct(eq / S.paper.start - 1)})`);
      } else say.push(`${tag}🏁 ${SYM} 정리 끝 (${S.pos.date} 매수분)`);
      S.pos = null; S.want = null;
    }

    // 8) SOXS 돌파 (남는 현금) ───────────────────────────
    await soxsLeg();
  } catch (e) {
    const m = `${e.message}`.slice(0, 200);
    if (S.errMsg !== m) say.push(`${tag}❌ 오류: ${m}`);
    S.errMsg = m; log.push(m);
  }
  return finish();

  async function soxsLeg() {
    const X = S.sx;
    if (mode === 'LIVE' && X.lastQty !== undefined && sq !== X.lastQty) say.push(`${tag}✅ ${SX} ${sq > X.lastQty ? '매수' : '매도'} 체결 ${Math.abs(sq - X.lastQty)}주 → 보유 ${sq}주`);
    X.lastQty = sq;
    if (!X.pos && sq > 0 && X.want == null) {
      if (X.foreignWarn !== et.date) say.push(`${tag}⚠️ 계좌에 봇 기록 없는 ${SX} ${sq}주 → SOXS 매매 보류`);
      X.foreignWarn = et.date; return;
    }
    if (X.order) {
      if (now.getTime() - X.order.at < waitMs) return;
      try {
        const rows = await broker.ordersToday();
        const row = rows.find(x => String(x.oder_no) === String(X.order.no) && String(x.oder_rctf_cncl_cls_code || '0') === '0');
        const rest = row ? X.order.qty - Number(row.cntg_qty || 0) : 0;
        if (row && rest > 0) await broker.cancel({ no: X.order.no, cls: X.order.cls, date: row.oder_date }, rest);
      } catch (e) { log.push(`SOXS 취소 실패 ${e.message}`); }
      X.order = null; return;
    }
    // 계획 (하루 한 번)
    if ((ses === 'pre' || ses === 'regular') && (!X.plan || X.plan.date !== et.date)) {
      const sd = (await mkt.yahoo(SYM, '1d', '3mo')).filter(b => b.date < et.date);
      X.plan = { date: et.date, ...sxPlan(sd) };
      X.plan.status = X.plan.active ? 'wait' : 'skip';
      if (X.plan.active) say.push(`${tag}📋 SOXS 돌파 대기: 전일 SOXL ${pct(X.plan.prevret)} → 오늘 SOXS 가 시가 +6% 넘으면 남는 현금으로 매수`);
    }
    let want = X.want ?? null, why = '';
    if (X.pos && sq > 0 && X.pos.date !== et.date && ses === 'pre' && et.min >= 9 * 60 + 28) { want = 0; why = '프리장 9:28 매도'; }
    if (ses === 'regular') {
      if (X.pos && X.pos.date !== et.date && sq > 0) { want = 0; why = '다음 날 시가 매도'; }
      const p = X.plan;
      if (p && p.date === et.date && p.status === 'wait' && !X.pos && et.min >= 9 * 60 + 31 && et.min < 15 * 60 + 58) {
        if (!(p.level > 0)) {
          const first = (await mkt.yahoo(SX, '1m', '1d', false)).find(b => b.date === et.date && b.min >= 570);
          if (first) { p.open = first.o; p.level = first.o * (1 + PX.k); say.push(`${tag}🎯 SOXS 시가 ${fmt(p.open)} → 돌파가 ${fmt(p.level)}`); }
        }
        if (p.level > 0) {
          const bars = (await mkt.yahoo(SX, '1m', '1d', false)).filter(b => b.date === et.date && b.min >= 570);
          const hi = Math.max(...bars.map(b => b.h), 0);
          const px = await broker.price(SX, 'regular');
          if (hi >= p.level || px >= p.level) {
            p.status = 'entered';
            const q = Math.floor((cash * mult) / (px * (1 + slip)));
            if (q > 0) { X.pos = { date: et.date, qty: q, cost: 0 }; want = q; why = `SOXS 돌파 (${fmt(p.level)})`; }
            else say.push(`${tag}ℹ️ SOXS 돌파했지만 남는 현금 없음`);
          }
        }
      }
    }
    if (want !== null) X.want = want;
    if (X.want != null && X.want !== sq) {
      const side = X.want > sq ? 'BUY' : 'SELL';
      let q = Math.abs(X.want - sq);
      let px;
      if (ses === 'regular') px = await broker.price(SX, 'regular');
      else if (ses === 'day') px = await broker.price(SX, 'day');
      else if (ses === 'after') px = await broker.price(SX, 'after');
      else { const b = await mkt.yahoo(SX, '1m', '1d', true); px = b.length ? b[b.length - 1].c : 0; }
      if (!(px > 0)) throw new Error(`SOXS ${ses} 가격 없음`);
      const lim = tick(side === 'BUY' ? px * (1 + slip) : px * (1 - slip));
      if (side === 'BUY') {
        const cashNow = mode === 'LIVE' ? cash : S.paper.cash;
        q = Math.min(q, Math.floor(cashNow / lim));
        const lv = X.plan && X.plan.level;
        if (ses !== 'regular' || et.min >= 15 * 60 + 58 || (lv > 0 && px > lv * 1.03)) {
          if (sq > 0) X.pos.qty = sq; else X.pos = null;
          X.want = sq > 0 ? sq : null; q = 0;
        }
      }
      if (q > 0) {
        if (mode === 'LIVE') {
          const o = await broker.order(side, SX, q, 'LIMIT', lim);
          X.order = { no: o.no, cls: o.cls, side, qty: q, at: now.getTime() };
          say.push(`${tag}📤 ${SX} ${side === 'BUY' ? '매수' : '매도'} ${q}주 지정가 ${fmt(lim)} (현재 ${fmt(px)}) · ${why || '이어서'} · #${o.no}`);
        } else {
          const fill = side === 'BUY' ? px * 1.001 : px * 0.999;
          if (side === 'BUY') { S.paper.cash -= q * fill; S.paper.sq = (S.paper.sq || 0) + q; X.pos.cost = (X.pos.cost || 0) + q * fill; }
          else { S.paper.cash += q * fill; S.paper.sq -= q; if (X.pos) X.pos.proceeds = (X.pos.proceeds || 0) + q * fill; }
          sq = S.paper.sq; X.lastQty = sq;
          say.push(`${tag}${side === 'BUY' ? '🟢 SOXS 매수' : '🔴 SOXS 매도'} ${q}주 @${fmt(fill)} (가상) · ${why}`);
        }
      }
    }
    if (X.pos && X.want === 0 && sq === 0 && !X.order) {
      if (mode !== 'LIVE' && X.pos.cost) {
        const pl = (X.pos.proceeds || 0) - X.pos.cost;
        say.push(`${tag}🏁 SOXS 끝 손익 ${pl >= 0 ? '+' : ''}$${fmt(pl)} (${pct(pl / X.pos.cost)}) · 가상자산 $${fmt(S.paper.cash)}`);
      } else say.push(`${tag}🏁 ${SX} 정리 끝`);
      X.pos = null; X.want = null;
    }
  }

  async function finish() {
    S.lock = 0;
    S.last = `${clk.kst.date} ${clk.kst.hhmm} KST ${ses}`;
    await save();
    if (say.length) await notify(say.join('\n'));
    return { log, say, S };
  }
}

// ── 메리츠 연결 (새 계좌 키) ───────────────────────────
const KEY = () => crypto.createHash('sha256').update('bo-token:' + (process.env.CRON_SECRET || '')).digest();
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
    if (!force && vars.BO_TOKEN) { const c = open_(vars.BO_TOKEN); if (c && c.exp > Date.now()) return (MEM = c); }
    MEM = await M.issueToken();
    try { await saveVar('BO_TOKEN', seal(MEM)); } catch { /* 무시 */ }
    return MEM;
  };
  const w = fn => async (...a) => {
    try { return await fn(await ensure(false), ...a); }
    catch (e) {
      if (e.code !== 'TOKEN_DEAD') throw e;
      try { return await fn(await ensure(true), ...a); }
      catch (e2) {
        if (e2.code !== 'TOKEN_DEAD') throw e2;
        await new Promise(r => setTimeout(r, 3000));   // 새 토큰도 거부되면 3초 쉬고 한 번 더 (발급 직후 반영 지연 대비)
        return fn(await ensure(true), ...a);
      }
    }
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
  // 이 함수 안에서만 새 계좌 키를 쓴다 (Vercel 함수는 파일마다 따로 돈다 → 다른 봇에 영향 없음)
  if (!process.env.MERITZ2_APP_KEY || !process.env.MERITZ2_APP_SECRET) return res.status(500).json({ ok: false, error: 'MERITZ2_APP_KEY/SECRET 없음' });
  process.env.MERITZ_APP_KEY = process.env.MERITZ2_APP_KEY;
  process.env.MERITZ_APP_SECRET = process.env.MERITZ2_APP_SECRET;
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
