// api/cron-manual.js — 조건 지정가 매수·매도 봇 (Vercel Cron 1분마다)
//
// GitHub Variables (sniper-bot 저장소)
//   MANUAL            규칙 (형식은 _manual_core.js 맨 위)
//   MANUAL_MODE       OFF | PAPER | LIVE   (없으면 PAPER = 모의, 주문 안 냄)
//   MANUAL_CASH_FLOOR 매수 후에도 남겨둘 달러 (스나이퍼 몫 보호). 없으면 0
//   MANUAL_SLIP       지정가 여유폭 (기본 0.005 = 0.5%)
//   MANUAL_STOP_SLIP  손절·트레일·만기 매도 지정가를 현재가보다 얼마나 낮게 (기본 0.02 = 2%, 바로 체결용)
//   MANUAL_WAIT_MIN   지정가 미체결 시 취소까지 분 (기본 2)
//   MANUAL_SESSIONS   돌릴 구간 (기본 day,pre,regular,after)
//   MANUAL_RSI        RSI 공식 WILDER (기본, 백테스트) | SMA (메리츠 앱 차트와 같음)
//   MANUAL_STATE      봇이 쓰는 상태 (건드리지 않기)
//   MANUAL_TICKS      RSI 웅덩이용 1분 시세 기록 (봇이 씀, 건드리지 않기)
//                     주간·프리·정규·애프터 메리츠 현재가를 1분마다 쌓아 끊김 없는 분봉을 만든다.
//                     야후 분봉엔 주간거래가 없어 주말·주간 하락이 봉 하나로 뭉쳐 가짜 웅덩이가 생겼다 (11/16)
// Vercel 환경변수: CRON_SECRET, GH_TOKEN(Variables 읽기·쓰기), MERITZ_APP_KEY, MERITZ_APP_SECRET, TG_TOKEN, TG_CHAT
import crypto from 'node:crypto';
import * as M from './_meritz.js';
import * as V from './_ghvars.js';
import { parseRules, clock, decide, pitSignal, trendOf, levels, nextWeekday, barTime, MIN_BARS, RSI_MODE } from './_manual_core.js';

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
  } catch { /* 알림 실패는 무시 */ }
}

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ── 1분 시세 기록 → 분봉 ─────────────────────────────────
const TICK_KEEP_MIN = 450;            // 7.5시간치 (3분봉 150개). 종목 2개여도 GitHub 변수 한도(48KB) 안
const KST_ID = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function kstIdOf(ms) {
  const o = {}; for (const p of KST_ID.formatToParts(new Date(ms))) o[p.type] = p.value;
  return `${o.year}${o.month}${o.day}${String(Number(o.hour) % 24).padStart(2, '0')}${o.minute}00`;
}
// ticks: 오래된 → 최신. [분, 가격] (매분 현재가) 또는 [분, 시, 고, 저, 종] (메리츠 실제 1분봉). 진행 중인 봉은 버린다
export function tickBars(ticks, sec, nowMs) {
  const step = sec / 60, out = [];
  const nowB = Math.floor(nowMs / 60000 / step);
  for (const t of ticks) {
    const m = t[0], o = t.length > 2 ? t[1] : t[1], h = t.length > 2 ? t[2] : t[1], l = t.length > 2 ? t[3] : t[1], c = t.length > 2 ? t[4] : t[1];
    const b = Math.floor(m / step);
    if (b >= nowB) break;
    const last = out[out.length - 1];
    if (last && last.b === b) { last.h = Math.max(last.h, h); last.l = Math.min(last.l, l); last.c = c; }
    else out.push({ b, id: kstIdOf(b * step * 60000), o, h, l, c });
  }
  return out.map(({ b, ...x }) => x);
}
// 저장은 작게: 분은 기준값과의 차이, 가격은 소수 둘째 자리 → 종목 2개 7.5시간치가 30KB 안팎
const r2 = x => Math.round(x * 100) / 100;
export function packTicks(T) {
  let b = Infinity; for (const a of Object.values(T)) if (a.length) b = Math.min(b, a[0][0]);
  if (!isFinite(b)) return { v: 2, b: 0, S: {} };
  const S = {}; for (const [k, a] of Object.entries(T)) S[k] = a.map(t => [t[0] - b, ...t.slice(1).map(r2)]);
  return { v: 2, b, S };
}
export function unpackTicks(J) {
  if (!J || J.v !== 2) return J && !J.v ? J : {};          // 옛 형식(그대로 배열)도 읽는다
  const T = {}; for (const [k, a] of Object.entries(J.S || {})) T[k] = a.map(t => [t[0] + J.b, ...t.slice(1)]);
  return T;
}
// 야후 분봉에서 30분 넘게 빈 곳(주간거래·주말)이 있으면 그 앞은 버린다 → 봉이 모자라면 판단 보류
export function cutGaps(bars, sec) {
  let from = 0;
  for (let i = 1; i < bars.length; i++) {
    const gap = (barTime(bars[i].id) - barTime(bars[i - 1].id)) / 60000;
    if (gap > Math.max(30, 3 * sec / 60)) from = i;
  }
  return bars.slice(from);
}

// 테스트에서 브로커·저장소를 갈아끼울 수 있게 분리
export async function runOnce({ vars, broker, now = new Date(), notify = tg, saveVar }) {
  const log = [];
  const say = [];
  const mode = String(vars.MANUAL_MODE || 'PAPER').toUpperCase();
  if (mode === 'OFF') return { log: ['OFF'] };
  const paper = mode !== 'LIVE';
  const tag = paper ? '[모의] ' : '';
  const clk = clock(now);
  const slip = num(vars.MANUAL_SLIP, 0.005);
  const stopSlip = num(vars.MANUAL_STOP_SLIP, 0.02);
  const waitMs = num(vars.MANUAL_WAIT_MIN, 2) * 60000;
  const floor = num(vars.MANUAL_CASH_FLOOR, 0);
  const sessions = String(vars.MANUAL_SESSIONS || 'day,pre,regular,after').split(',').map(s => s.trim());
  RSI_MODE.kind = String(vars.MANUAL_RSI || 'WILDER').trim().toUpperCase() === 'SMA' ? 'SMA' : 'WILDER';
  const year = Number(clk.et.date.slice(0, 4));
  const { rules, errors } = parseRules(vars.MANUAL, year);

  let S = {};
  try { S = JSON.parse(vars.MANUAL_STATE || '{}'); } catch { S = {}; }
  S.rules = S.rules || {};
  S.errs = S.errs || '';
  const errText = errors.join('\n');
  if (errText && errText !== S.errs) say.push(`⚠️ MANUAL 규칙 오류\n${errText}`);
  S.errs = errText;
  // 모드가 바뀌면(PAPER↔LIVE) 이전 모드의 진행 상태는 버린다. 모의로 '산' 수량을 실계좌에서 팔지 않게
  if (S.mode && S.mode !== mode) {
    for (const [k, st] of Object.entries(S.rules)) if (!(st.ord && !st.ord.paper)) delete S.rules[k];
    say.push(`ℹ️ 모드 ${S.mode} → ${mode}: 규칙 진행 상태 초기화`);
  }
  S.mode = mode;

  const keys = new Set(rules.map(r => r.key));
  const open = Object.entries(S.rules).filter(([, st]) => st.ord);
  if (!rules.length && !open.length) {
    if (Object.keys(S.rules).length) { S.rules = {}; await saveVar('MANUAL_STATE', JSON.stringify(S)); }
    if (say.length) await notify(say.join('\n\n'));
    return { log: ['규칙 없음'] };
  }

  // 할 일 없으면 저장도 안 하고 끝 (장 닫힘 또는 모든 규칙 끝남)
  const live = rules.some(r => r.repeat || !['done', 'error', 'expired'].includes((S.rules[r.key] || {}).st));
  const sessionOk = clk.session !== 'closed' && sessions.includes(clk.session);
  if (!open.length && (!live || !sessionOk)) {
    if (say.length) { await saveVar('MANUAL_STATE', JSON.stringify(S)); await notify(say.join('\n\n')); }
    return { log: [live ? `장 닫힘 (${clk.session})` : '모든 규칙 끝남'] };
  }

  // 겹쳐 돌지 않게 50초 잠금
  if (S.lock && now.getTime() - S.lock < 50000) return { log: ['잠금 중'] };
  S.lock = now.getTime();
  await saveVar('MANUAL_STATE', JSON.stringify(S));

  const sessionOn = sessionOk;
  let extraDelta = 0;
  const pxCache = {};
  const getPx = async sym => (pxCache[sym] ??= await broker.price(sym, clk.session));
  let todays = null;
  const getToday = async () => (todays ??= await broker.ordersToday());
  let hold = null;
  const getHold = async () => (hold ??= await broker.holdings());
  const candleCache = {}, dayCache = {};
  let T = {}; try { T = unpackTicks(JSON.parse(vars.MANUAL_TICKS || '{}')); } catch { T = {}; }
  let ticksDirty = false;
  // RTH 규칙: 야후 분봉 중 정규장 봉만 (백테스트와 같음)
  // 그 외: 직접 쌓은 1분 시세로 만든 분봉 → 100봉이 안 되면 야후 분봉(공백 앞은 버림)
  const getBars = async (sym, sec, rth) => {
    const k = `${sym}:${sec}:${rth ? 'R' : 'A'}`;
    if (candleCache[k]) return candleCache[k];
    if (rth) return (candleCache[k] = (await broker.candles(sym, sec)).filter(b => clock(barTime(b.id)).session === 'regular'));
    const tb = tickBars(T[sym] || [], sec, now.getTime());
    if (tb.length >= MIN_BARS) return (candleCache[k] = tb);
    return (candleCache[k] = cutGaps(await broker.candles(sym, sec), sec));
  };
  const getDays = async sym => (dayCache[sym] ??= await broker.days(sym));
  const closing = clk.session === 'regular' && clk.et.min >= 15 * 60 + 45;
  const eodDate = () => (clk.session === 'after' || closing ? nextWeekday(clk.tradeDate) : clk.tradeDate);
  const lvText = st => [st.tpPx ? `익절 ${fmt(st.tpPx)}` : '', st.slPx ? `손절 ${fmt(st.slPx)}` : '', st.expDate ? `정리 ${st.expDate} 종가` : ''].filter(Boolean).join(' / ');

  // 1) 걸려 있는 주문 확인 (규칙이 지워졌어도 주문은 끝까지 챙긴다)
  for (const [key, st] of Object.entries(S.rules)) {
    if (!st.ord) continue;
    const r = rules.find(x => x.key === key) || st.rule;
    const o = st.ord;
    let filled = 0, finished = false, avg = o.px;
    if (o.paper) {
      filled = o.qty; finished = true; avg = o.mkt || o.px || (await getPx(r.sym)); // 모의는 현재가로 체결
    } else {
      const row = (await getToday()).find(x => String(x.oder_no) === String(o.no) && String(x.oder_rctf_cncl_cls_code || '0') === '0');
      if (row) {
        o.date = row.oder_date;
        filled = Number(row.cntg_qty || 0);
        if (Number(row.cntg_crnc_prc) > 0) avg = Number(row.cntg_crnc_prc);
        const cancelled = Number(row.cncl_cnfr_qty || 0);
        const stat = String(row.ovrs_stck_oder_stat_cls_code || '0');
        if (['1', '2', '4'].includes(stat)) { finished = true; if (!filled) say.push(`❌ ${r.sym} ${o.side} 주문 거부: ${row.ovrs_stck_rfus_reas || stat}`); }
        else if (filled + cancelled >= o.qty || stat === '3') finished = true;
      } else if (now.getTime() - o.at > 15 * 60000) {
        // 당일 목록에서 사라짐(날짜 넘어감 등) → 잔고로 추정
        const h = (await getHold())[r.sym];
        const q = h ? h.qty : 0;
        filled = Math.max(0, Math.min(o.qty, o.side === 'BUY' ? q - o.base : o.base - q));
        finished = true;
        say.push(`ℹ️ ${r.sym} 주문 #${o.no} 내역 조회 안 됨 → 잔고로 ${filled}주 체결 처리. 확인 부탁`);
      }
      const age = now.getTime() - o.at;
      const mocWait = o.kind === 'MOC' && !(clk.session !== 'regular' || clk.et.min >= 16 * 60);
      if (!finished && !mocWait && age >= waitMs && !o.cancelSent && o.date) {
        try { await broker.cancel({ no: o.no, cls: o.cls, date: o.date }, o.qty - filled); o.cancelSent = now.getTime(); log.push(`${r.sym} #${o.no} 취소 요청`); }
        catch (e) { log.push(`취소 실패 ${e.message}`); }
      }
      if (!finished && o.cancelSent && now.getTime() - o.cancelSent > 5 * 60000) {
        finished = true; say.push(`⚠️ ${r.sym} #${o.no} 취소 확인 안 됨. 체결 ${filled}주로 처리. 앱에서 확인 부탁`);
      }
    }
    if (!finished) continue;
    // 주문 마감 반영
    const prevFilled = o.counted || 0;
    const add = filled - prevFilled;
    if (o.side === 'BUY') {
      if (add > 0) {
        st.cost = (st.cost || 0) + add * avg;
        st.bought = (st.bought || 0) + add;
        if (r.sym === 'SOXL') extraDelta += add;
        // 체결가 기준으로 익절·손절 라인 계산
        const entry = st.cost / st.bought;
        const lv = levels(r, entry, st.pitLow);
        st.tpPx = lv.tp; st.slPx = lv.sl;
        if (r.eod && !st.expDate) st.expDate = eodDate();
        if (o.sigId) st.lastSig = o.sigId;
        say.push(`${tag}✅ ${r.sym} 매수 ${add}주 @${fmt(avg)}  (${o.why})${lvText(st) ? '\n   🎯 ' + lvText(st) : ''}`);
      }
      st.ord = null;
      if (st.bought >= (o.want ?? r.qty) || (st.bought > 0 && filled < o.qty)) {
        st.st = (r.tp || r.sl || r.exp || r.eod) ? 'hold' : 'done';
        if (st.bought < (o.want ?? r.qty)) say.push(`ℹ️ ${r.sym} ${st.bought}/${o.want ?? r.qty}주만 매수됨. 이 수량으로 진행`);
      } else {
        st.st = 'wait';
        st.tries = (st.tries || 0) + 1;
        if (st.tries >= 5) { st.st = 'error'; say.push(`⚠️ ${r.sym} 매수 5번 미체결 → 규칙 정지`); }
      }
    } else {
      if (add > 0) {
        st.sold = (st.sold || 0) + add;
        st.proceeds = (st.proceeds || 0) + add * avg;
        if (r.sym === 'SOXL') extraDelta -= add;
        say.push(`${tag}✅ ${r.sym} 매도 ${add}주 @${fmt(avg)}  (${o.why})`);
      }
      st.ord = null;
      if (st.sold >= st.bought) {
        st.st = 'done';
        if (st.cost) {
          const pl = st.proceeds - st.cost;
          say.push(`🏁 ${r.sym} 끝  손익 ${pl >= 0 ? '+' : ''}$${fmt(pl)} (${fmt((pl / st.cost) * 100)}%)`);
        } else say.push(`🏁 ${r.sym} 매도 끝  ${st.sold}주 $${fmt(st.proceeds)}`);
      } else st.st = 'hold';
    }
  }

  // 2) 지워진 규칙 정리
  for (const k of Object.keys(S.rules)) if (!keys.has(k) && !S.rules[k].ord) delete S.rules[k];

  // 3) 새 판단
  if (sessionOn) {
    // 3-0) RSI 웅덩이 규칙 종목의 현재가를 1분마다 기록 (주간거래 포함, 끊김 없는 분봉용)
    const nowMin = Math.floor(now.getTime() / 60000);
    for (const sym of new Set(rules.filter(r => r.pit && !r.rth).map(r => r.sym))) {
      try {
        const arr = (T[sym] ||= []);
        // ① 메리츠 실제 1분봉(완성된 봉)으로 시·고·저·종을 채운다 → 앱 차트와 같은 봉
        try {
          const one = await broker.candles(sym, 60);
          const map = new Map(arr.map(x => [x[0], x]));
          for (const b of one) {
            const m = Math.floor(barTime(b.id).getTime() / 60000);
            if (!(m >= nowMin - TICK_KEEP_MIN && m < nowMin) || !(b.c > 0)) continue;
            const row = [m, b.o, b.h, b.l, b.c], old = map.get(m);
            if (!old || old.length < 5 || old[4] !== b.c || old[2] !== b.h || old[3] !== b.l) { map.set(m, row); ticksDirty = true; }
          }
          arr.length = 0; arr.push(...[...map.values()].sort((a, b) => a[0] - b[0]));
        } catch (e) { log.push(`${sym} 1분봉 실패(현재가로 대신) ${e.message}`); }
        // ② 1분봉이 없는 분(주간거래 등)은 매분 현재가로 메운다
        const p = await getPx(sym);
        if (p > 0 && (!arr.length || arr[arr.length - 1][0] < nowMin)) { arr.push([nowMin, p]); ticksDirty = true; }
        while (arr.length && arr[0][0] < nowMin - TICK_KEEP_MIN) { arr.shift(); ticksDirty = true; }
      } catch (e) { log.push(`${sym} 시세 기록 실패 ${e.message}`); }
    }
    for (const r of rules) {
      const st = S.rules[r.key] ??= r.side === 'SELL'
        ? { st: 'hold', bought: r.qty, sold: 0, rule: r }
        : { st: 'wait', bought: 0, sold: 0, rule: r };
      st.rule = r;
      // REPEAT: 끝난 규칙은 다음 거래일에 다시 대기
      if (r.repeat && ['done', 'expired'].includes(st.st) && !st.ord && (st.day || '') < clk.tradeDate) {
        Object.assign(st, { st: 'wait', bought: 0, sold: 0, cost: 0, proceeds: 0, tpPx: null, slPx: null, expDate: null, exiting: null, tries: 0, pitLow: null, day: clk.tradeDate });
      }
      if (['done', 'error', 'expired'].includes(st.st) || st.ord) continue;
      let px;
      try { px = await getPx(r.sym); } catch (e) { log.push(`${r.sym} 시세 실패 ${e.message}`); continue; }
      // 이미 가진 주식(SELL) 의 퍼센트·R 라인은 평균단가 기준으로 한 번 계산
      if (r.side === 'SELL' && !st.lvSet) {
        const avg = paper ? px : ((await getHold())[r.sym] || {}).avg || px;
        const lv = levels(r, avg, null);
        st.tpPx = lv.tp; st.slPx = lv.sl; st.lvSet = 1;
        if (r.eod) st.expDate = eodDate();
        if (lvText(st)) say.push(`${tag}🎯 ${r.sym} ${r.qty}주 감시 시작 (기준 ${fmt(avg)}) ${lvText(st)}`);
      }
      const ctx = { px, clk, slip, stopSlip };
      if (st.st === 'wait') {
        try {
          if (r.pit && (!r.rth || clk.session === 'regular')) {
            const bars = await getBars(r.sym, r.pit.sec, r.rth);
            ctx.sig = pitSignal(bars, r.pit.depth);
            if (ctx.sig.short && S.warnBars !== clk.tradeDate) { S.warnBars = clk.tradeDate; say.push(`⚠️ ${r.sym} ${r.pit.sec / 60}분봉이 ${ctx.sig.n}개뿐이라 RSI 웅덩이 판단 보류 (100개 필요)`); }
          }
          if (r.trend) ctx.trend = trendOf(await getDays(r.sym), clk.tradeDate);
        } catch (e) { log.push(`${r.sym} 봉 조회 실패 ${e.message}`); continue; }
      }
      const d = decide(r, st, ctx);
      if (d.act === 'NONE' || d.act === 'WAIT_ORDER') continue;
      if (d.act === 'EXPIRE') { st.st = 'expired'; say.push(`⌛ ${r.sym} 매수 대기 만료: ${r.key}`); continue; }
      if (d.act === 'DONE') { st.st = 'done'; continue; }
      if (d.kind === 'MOC' && clk.session !== 'regular') continue;

      let qty = d.qty;
      const h = paper ? null : (await getHold())[r.sym];
      if (d.act === 'BUY' && !paper) {
        const cash = await broker.cash();
        const can = Math.floor((cash - floor) / d.px);
        if (can < qty) {
          if (can <= 0) { if (!st.cashWarned) say.push(`⚠️ ${r.sym} 매수 보류: 현금 $${fmt(cash)} (하한 $${fmt(floor)})`); st.cashWarned = 1; continue; }
          say.push(`ℹ️ ${r.sym} 현금 부족 → ${qty}주 대신 ${can}주`);
          qty = can;
        }
      }
      if (d.act === 'SELL' && !paper) {
        const sellable = h ? h.sellable : 0;
        if (sellable < qty) {
          if (sellable <= 0) { if (!st.sellWarned) say.push(`⚠️ ${r.sym} 매도 보류: 매도가능 0주`); st.sellWarned = 1; continue; }
          qty = sellable;
        }
        if (/익절|손절|만기/.test(d.why) && !st.exiting) st.exiting = d.why.replace(/ .*/, '');
      }
      if (d.act === 'SELL' && paper && /익절|손절|만기/.test(d.why) && !st.exiting) st.exiting = d.why.replace(/ .*/, '');

      const side = d.act;
      const ord = { side, qty, kind: d.kind, px: d.px, why: d.why, at: now.getTime(), base: h ? h.qty : 0, counted: 0, want: (st.bought || 0) + qty, sigId: d.sigId || null };
      if (side === 'BUY') { if (d.pitLow) st.pitLow = d.pitLow; st.day = clk.tradeDate; }
      if (paper) {
        ord.paper = 1; ord.no = 'P' + now.getTime(); ord.mkt = px;
        if (!ord.px) ord.px = px;
        say.push(`${tag}📤 ${r.sym} ${side === 'BUY' ? '매수' : '매도'} ${qty}주 ${d.kind === 'MOC' ? 'MOC' : '지정가 ' + fmt(d.px)}  현재 ${fmt(px)} · ${d.why} · ${clk.session}`);
      } else {
        try {
          const res = await broker.order(side, r.sym, qty, d.kind, d.px);
          ord.no = res.no; ord.cls = res.cls; ord.date = null;
          say.push(`📤 ${r.sym} ${side === 'BUY' ? '매수' : '매도'} ${qty}주 ${d.kind === 'MOC' ? 'MOC' : '지정가 ' + fmt(d.px)}  현재 ${fmt(px)} · ${d.why} · ${clk.session} · #${res.no}`);
        } catch (e) {
          st.fails = (st.fails || 0) + 1;
          say.push(`❌ ${r.sym} 주문 실패 ${e.message}${st.fails >= 3 ? ' → 규칙 정지' : ''}`);
          if (st.fails >= 3) st.st = 'error';
          continue;
        }
      }
      st.ord = ord;
      st.st = side === 'BUY' ? 'buying' : 'selling';
      // 실주문은 바로 저장 (중간에 죽어도 같은 주문을 또 내지 않게)
      if (!paper) await saveVar('MANUAL_STATE', JSON.stringify(S));
    }
  }

  // 4) EXTRA_SHARES 맞추기 (SOXL 실거래만)
  if (extraDelta && !paper) {
    const cur = Number(vars.EXTRA_SHARES || 0);
    try { await saveVar('EXTRA_SHARES', String(cur + extraDelta), 'EXTRA_SHARES' in vars); say.push(`ℹ️ EXTRA_SHARES ${cur} → ${cur + extraDelta}`); }
    catch (e) { say.push(`⚠️ EXTRA_SHARES 갱신 실패 (${cur}→${cur + extraDelta}) 직접 고쳐주세요: ${e.message}`); }
  }

  if (ticksDirty) { try { await saveVar('MANUAL_TICKS', JSON.stringify(packTicks(T))); } catch (e) { log.push(`시세 기록 저장 실패 ${e.message}`); } }
  S.lock = 0;
  S.last = `${clk.kst.date} ${clk.kst.hhmm} KST ${clk.session}`;
  await saveVar('MANUAL_STATE', JSON.stringify(S));
  if (say.length) await notify(say.join('\n'));
  return { log, say, S };
}

// 메리츠 실제 연결. 토큰은 함수 메모리 → 없으면 MANUAL_TOKEN(CRON_SECRET 으로 암호화된 값) → 없으면 새로 발급
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
let MEM_TOKEN = null;
function liveBroker(vars, saveVar) {
  const ensure = async (force) => {
    if (!force && MEM_TOKEN && MEM_TOKEN.exp > Date.now()) return MEM_TOKEN;
    if (!force && vars.MANUAL_TOKEN) { const c = open_(vars.MANUAL_TOKEN); if (c && c.exp > Date.now()) return (MEM_TOKEN = c); }
    MEM_TOKEN = await M.issueToken();
    try { await saveVar('MANUAL_TOKEN', seal(MEM_TOKEN)); } catch { /* 캐시 실패는 무시 */ }
    return MEM_TOKEN;
  };
  const w = fn => async (...a) => {
    try { return await fn(await ensure(false), ...a); }
    catch (e) { if (e.code === 'TOKEN_DEAD') return fn(await ensure(true), ...a); throw e; }
  };
  return {
    price: w((t, s, ses) => M.price(t, s, ses)),
    ordersToday: w(t => M.ordersToday(t)),
    holdings: w(t => M.holdings(t)),
    cash: w(t => M.cashUSD(t)),
    order: w((t, side, s, q, k, p) => M.order(t, side, s, q, k, p)),
    cancel: w((t, o, q) => M.cancel(t, o, q)),
    candles: w((t, s, sec) => M.candles(t, s, sec)),
    days: w((t, s) => M.days(t, s)),
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
    return res.status(200).json({ ok: true, log: out.log, sent: out.say || [] });
  } catch (e) {
    // 잠금 풀기
    try { const S = JSON.parse(vars.MANUAL_STATE || '{}'); S.lock = 0; await saveVar('MANUAL_STATE', JSON.stringify(S)); } catch { /* 무시 */ }
    const msg = String(e && e.message || e).slice(0, 300);
    await tg(`⚠️ 조건주문 봇 오류: ${msg}`);
    return res.status(500).json({ ok: false, error: msg });
  }
}
