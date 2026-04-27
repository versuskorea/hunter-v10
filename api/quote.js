// api/quote.js - Yahoo Finance 최신 종가 + 20일 전고
// 사용법: GET /api/quote?symbol=SOXL  또는  /api/quote (기본 SOXL)

export default async function handler(req, res) {
// ✅ symbol 파라미터 받기 (없으면 SOXL 기본)
const symbol = ((req.query.symbol || ‘SOXL’) + ‘’).toUpperCase().trim();

try {
// 최근 40거래일치 가져오기 (20일 전고 + 여유분)
const now = Math.floor(Date.now() / 1000);
const sixtyDaysAgo = now - 60 * 86400;

```
const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${sixtyDaysAgo}&period2=${now}&interval=1d&includePrePost=false`;

const yahooRes = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  }
});

if (!yahooRes.ok) {
  return res.status(502).json({ error: `Yahoo API ${yahooRes.status}` });
}

const data = await yahooRes.json();

if (data?.chart?.error) {
  return res.status(502).json({ error: data.chart.error.description || `${symbol} 종목 없음` });
}

const result = data?.chart?.result?.[0];
if (!result) {
  return res.status(404).json({ error: `${symbol} 데이터 없음` });
}

const timestamps = result.timestamp || [];
const quote = result.indicators?.quote?.[0] || {};
const highs = quote.high || [];
const closes = quote.close || [];
const meta = result.meta || {};

// 유효한 날짜만 추출 (null 제외)
const validBars = [];
for (let i = 0; i < timestamps.length; i++) {
  if (closes[i] == null || highs[i] == null) continue;
  validBars.push({
    ts: timestamps[i],
    high: highs[i],
    close: closes[i]
  });
}

if (validBars.length === 0) {
  return res.status(404).json({ error: `${symbol} 거래 데이터 없음` });
}

// 시장 상태 (야후 meta에서)
const marketState = meta.marketState || 'UNKNOWN';

// 🔥 핵심 수정: 장중이면 오늘 bar 제외 (실시간 가격 X, 어제 종가 사용)
// PRE = 프리장, REGULAR = 정규장, POST = 애프터장 → 모두 "오늘 bar" 진행 중
// CLOSED = 장 마감 → 오늘 bar는 확정 종가
const isMarketActive = ['PRE', 'REGULAR', 'POST'].includes(marketState);

let confirmedBars = validBars;
if (isMarketActive && validBars.length >= 2) {
  // 마지막 bar가 "오늘 (진행 중)" → 제외
  const lastBarDate = new Date(validBars[validBars.length - 1].ts * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (lastBarDate === today) {
    confirmedBars = validBars.slice(0, -1);
  }
}

if (confirmedBars.length === 0) {
  return res.status(404).json({ error: `${symbol} 확정 종가 없음` });
}

// 확정 종가 = 마지막 확정 bar (장중이면 어제 종가)
const latest = confirmedBars[confirmedBars.length - 1];
const latestDate = new Date(latest.ts * 1000).toISOString().slice(0, 10);
const latestClose = +latest.close.toFixed(2);

// 20일 전고 = 확정된 bar 중 최근 20일
const last20 = confirmedBars.slice(-20);
const high20 = +Math.max(...last20.map(b => b.high)).toFixed(2);

// 캐시 5분 (너무 자주 Yahoo 때리지 말라고)
res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

return res.status(200).json({
  symbol: symbol,
  price: latestClose,
  high20: high20,
  lastDate: latestDate,
  marketState: marketState,
  barCount: confirmedBars.length,
  isLive: isMarketActive,  // 장중 여부 표시
  excludedTodayBar: isMarketActive && validBars.length > confirmedBars.length
});
```

} catch (err) {
console.error(‘quote.js error:’, err);
return res.status(500).json({ error: err.message || ‘서버 오류’ });
}
}