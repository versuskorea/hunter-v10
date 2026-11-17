// api/_bo_core.js — SOXL 돌파 봇 판단 로직 (네트워크 없음 → 테스트 가능) · 밑줄 파일은 라우트가 아님
//
// 규칙 (백테스트 mega3 시드63: 2010.5~2026.9 연 76% / MDD −22%, 연 134회, 승률 60%)
//   국면     전일 NQ 종가 > NQ 200일선 → 공격 / 아니면 수비
//   쉼       전일 SOXL 일봉 RSI14 > 85 · 프리장 마지막가가 전일 종가 대비 −2% 미만 · 수비인데 (전일 상승 그리고 RSI ≥ 40)
//   돌파가   오늘 시가 + k × ATR5 (전일까지 5일 평균 진폭)   공격 k 0.17 · 수비 k 0.51
//   비중     공격 자산의 50% · 수비 100%
//   매수     정규장 중 가격이 돌파가 이상 → 지정가 매수 (하루 한 번)
//   매도     다음 거래일 정규장 시작에 전량 매도
//   밤사이   16:00 NQ 가격 대비 NQ 가 공격 −1% / 수비 −1.5% 내려가면 그때 열린 장(애프터·주간·프리)에서 전량 매도

export const P = {
  atk: { k: 0.17, w: 0.5, stop: 0.01 },
  def: { k: 0.51, w: 1.0, stop: 0.015 },
  nqMA: 200, rsiMax: 85, rsiLow: 40, pmSkip: -0.02, atrN: 5,
};

// pandas ewm(alpha=1/n, adjust=False) 와 같은 RSI (백테스트와 동일). closes 오래된 → 최신, 마지막 값 반환
export function rsiLast(closes, n = 14) {
  let up = 0, dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    up = up + (Math.max(d, 0) - up) / n;
    dn = dn + (Math.max(-d, 0) - dn) / n;
  }
  return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
}

// days: 완성된 일봉 오래된 → 최신 {date,o,h,l,c}. 마지막 n 일의 True Range 평균
export function atr(days, n = 5) {
  const tr = [];
  for (let i = Math.max(1, days.length - n); i < days.length; i++) {
    const { h, l } = days[i], pc = days[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return tr.reduce((a, b) => a + b, 0) / tr.length;
}

// 오늘 계획 (시가 전): soxl 완성 일봉, nq 완성 일봉 종가
export function plan(soxl, nqCloses) {
  if (soxl.length < 30 || nqCloses.length < P.nqMA) return { mode: 'skip', why: `데이터 부족 (SOXL ${soxl.length}일, NQ ${nqCloses.length}일)` };
  const c = soxl.map(d => d.c);
  const rsi = rsiLast(c);
  const prevret = c[c.length - 1] / c[c.length - 2] - 1;
  const nqLast = nqCloses[nqCloses.length - 1];
  const nqMa = nqCloses.slice(-P.nqMA).reduce((a, b) => a + b, 0) / P.nqMA;
  const nqUp = nqLast > nqMa;
  const a = atr(soxl, P.atrN);
  const base = { rsi, prevret, nqUp, nqLast, nqMa, atr: a, prevClose: c[c.length - 1], prevDate: soxl[soxl.length - 1].date };
  if (rsi > P.rsiMax) return { ...base, mode: 'skip', why: `RSI ${rsi.toFixed(1)} > ${P.rsiMax}` };
  if (nqUp) return { ...base, mode: 'atk', ...P.atk };
  if (prevret < 0 || rsi < P.rsiLow) return { ...base, mode: 'def', ...P.def };
  return { ...base, mode: 'skip', why: `수비 국면인데 전일 상승(${(prevret * 100).toFixed(1)}%)·RSI ${rsi.toFixed(1)} ≥ ${P.rsiLow}` };
}

// 시가가 나온 뒤: 프리장 필터와 돌파가
export function arm(pl, open, preLast) {
  const pm = preLast > 0 ? preLast / pl.prevClose - 1 : 0;
  if (pm < P.pmSkip) return { ...pl, mode: 'skip', why: `프리장 ${(pm * 100).toFixed(1)}% < −2%`, open, pm };
  return { ...pl, open, pm, level: open + pl.k * pl.atr };
}

// 밤사이 손절 여부
export const stopHit = (nq0, nqNow, y) => nq0 > 0 && nqNow > 0 && nqNow <= nq0 * (1 - y);

// ── SOXS 돌파 (남는 현금) ─────────────────────────────────
// 전일 SOXL +2% 이상 (그리고 20일 상승이 +50% 이하) → 오늘 SOXS 가 시가 × 1.06 이상이면 남는 현금으로 매수, 다음 날 시가 매도
// 백테스트 (3분봉 체결, 2016~2026.9): SOXL 돌파와 합치면 연 130% / MDD −22% (SOXL 돌파만 76% / −20%)
export const PX = { up: 0.02, k: 0.06, maxRun20: 0.5 };
export function sxPlan(soxl) {
  const c = soxl.map(d => d.c), n = c.length;
  if (n < 22) return { active: false, why: '데이터 부족' };
  const prevret = c[n - 1] / c[n - 2] - 1, run20 = c[n - 1] / c[n - 21] - 1;
  if (prevret < PX.up) return { active: false, prevret, run20, why: `전일 SOXL ${(prevret * 100).toFixed(1)}% < +2%` };
  if (run20 > PX.maxRun20) return { active: false, prevret, run20, why: `20일 상승 +${(run20 * 100).toFixed(0)}% > +50% (폭주 상승장)` };
  return { active: true, prevret, run20 };
}
// 계좌 안전장치: 계좌 고점 대비 −20% 아래면 새 매수 비중 절반
export const DD = { cut: 0.2, mult: 0.5 };
export const ddMult = (eq, peak) => (peak > 0 && eq / peak - 1 < -DD.cut ? DD.mult : 1);
