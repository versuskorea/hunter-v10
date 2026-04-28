// api/quote.js - Yahoo Finance 최신 종가 + 20일 전고
// 안전 버전: 장중 처리 + 폴백 로직

export default async function handler(req, res) {
const symbol = ((req.query.symbol || ‘SOXL’) + ‘’).toUpperCase().trim();

try {
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

const marketState = meta.marketState || 'UNKNOWN';

// 장중 처리: 오늘 bar 제외 (안전 폴백)
const isMarketActive = ['PRE', 'REGULAR', 'POST'].includes(marketState);

let confirmedBars = validBars;
let excludedToday = false;

if (isMarketActive && validBars.length >= 2) {
  try {
    const lastBarTs = validBars[validBars.length - 1].ts;
    const lastBarDate = new Date(lastBarTs * 1000).toISOString().slice(0, 10);
    const todayUTC = new Date();
    const usEastDate = new Date(todayUTC.getTime() - 4 * 3600 * 1000).toISOString().slice(0, 10);
    
    if (lastBarDate === usEastDate) {
      confirmedBars = validBars.slice(0, -1);
      excludedToday = true;
    }
  } catch (e) {
    confirmedBars = validBars;
  }
}

if (confirmedBars.length === 0) {
  confirmedBars = validBars;
  excludedToday = false;
}

const latest = confirmedBars[confirmedBars.length - 1];
const latestDate = new Date(latest.ts * 1000).toISOString().slice(0, 10);
const latestClose = +latest.close.toFixed(2);

const last20 = confirmedBars.slice(-20);
const high20 = +Math.max(...last20.map(b => b.high)).toFixed(2);

res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

return res.status(200).json({
  symbol: symbol,
  price: latestClose,
  high20: high20,
  lastDate: latestDate,
  marketState: marketState,
  barCount: confirmedBars.length,
  isLive: isMarketActive,
  excludedTodayBar: excludedToday
});
```

} catch (err) {
console.error(‘quote.js error:’, err);
return res.status(500).json({ error: err.message || ‘서버 오류’ });
}
}