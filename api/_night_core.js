// api/_night_core.js — 밤 돌파 판단 로직 (계좌1, 스나이퍼 남는 현금) · 네트워크 없음 → 테스트 가능
//
// 규칙 (백테스트 ns_51: 계좌1 스나이퍼+웨이브 2010.6~ 연 62% / MDD −49% → 밤돌파 더하면 연 95% / −52%)
//   큰 국면   오늘 NQ 가 200일선 위 그리고 200일선이 5일 전보다 높음 (상승 추세) — 아니면 쉼
//   돌파가    오늘 시가 + k × 전일 진폭(고가−저가)
//               NQ 가 20일선 위 → k 0.23, 비중 100%
//               NQ 가 20일선 아래 → k 0.91, 비중 50%
//   쉼        최근 5일 평균 진폭(고가−저가)/종가 > 12% (너무 출렁이는 장)
//   매수      오늘 고가가 돌파가 이상이면 종가에 매수 (MOC)
//   금액      스나이퍼가 안 쓰는 현금 × 비중, 계좌 자산의 70% 까지
//   매도      다음 날 프리장 9:28 (안 팔리면 정규장 시가) · 밤사이 NQ 가 16:00 대비 −1% 내려가면 그때 열린 장에서 매도
// NQ 비교값은 '오늘 종가' 자리에 매수 직전 NQ 가격을 넣는다 (백테스트는 종가 기준)

export const N = { kA: 0.23, kD: 0.91, wA: 1.0, wD: 0.5, vmax: 0.12, fast: 20, slow: 200, slope: 5, stop: 0.01, cap: 0.7 };

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

// soxl: 완성 일봉 (오래된 → 최신, 오늘 제외) {date,o,h,l,c} · nqC: NQ 완성 종가 (오늘 제외) · nqNow: 지금 NQ
export function nightPlan(soxl, nqC, nqNow) {
  if (soxl.length < 6 || nqC.length < N.slow + N.slope) return { ok: false, why: `데이터 부족 (SOXL ${soxl.length}일, NQ ${nqC.length}일)` };
  const last = soxl[soxl.length - 1];
  const rng = last.h - last.l;
  const vol5 = mean(soxl.slice(-5).map(d => (d.h - d.l) / d.c));
  const arr = [...nqC, nqNow], t = arr.length - 1;
  const ma = (k, i) => mean(arr.slice(i - k + 1, i + 1));
  const maNow = ma(N.slow, t), maPrev = ma(N.slow, t - N.slope);
  const trend = nqNow > maNow && maNow > maPrev;
  const fastUp = nqNow > ma(N.fast, t);
  const base = { rng, vol5, trend, fastUp, nqNow, maNow, maPrev, k: fastUp ? N.kA : N.kD, w: fastUp ? N.wA : N.wD, prevDate: last.date };
  if (!trend) return { ...base, ok: false, why: `NQ 200일선 상승추세 아님 (NQ ${nqNow.toFixed(0)}, 200일선 ${maNow.toFixed(0)} ${maNow > maPrev ? '↑' : '↓'})` };
  if (vol5 > N.vmax) return { ...base, ok: false, why: `5일 평균 진폭 ${(vol5 * 100).toFixed(1)}% > 12%` };
  return { ...base, ok: true };
}

// 오늘 시가·고가로 신호 판단
export function nightFire(pl, open, high) {
  if (!pl.ok || !(open > 0)) return { fire: false };
  const level = open + pl.k * pl.rng;
  return { fire: high >= level, level };
}

// 매수 금액: 남는 현금(주문가능) × 비중, 계좌 자산 × 70% 까지
export const nightBudget = (cash, equity, w) => Math.max(0, Math.min(cash, N.cap * equity) * w);

export const nightStop = (nq0, nqNow) => nq0 > 0 && nqNow > 0 && nqNow <= nq0 * (1 - N.stop);
