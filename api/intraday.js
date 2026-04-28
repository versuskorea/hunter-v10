// api/intraday.js - 분봉/시간봉 데이터 + 실시간 가격
// 사용법: GET /api/intraday?symbol=SOXL&interval=1m  (1m, 10m, 1h, 1d)

export default async function handler(req, res) {
const symbol = ((req.query.symbol || ‘SOXL’) + ‘’).toUpperCase().trim();
const interval = (req.query.interval || ‘1m’).toLowerCase();

// 인터벌별 기간 설정
const config = {
‘1m’:  { yahooInterval: ‘1m’,  rangeDays: 1,  barsKeep: 200 },  // 1분봉 → 1일치 (390개 거래시간)
‘10m’: { yahooInterval: ‘5m’,  rangeDays: 5,  barsKeep: 100 },  // 5분봉 가져와서 클라가 표시 (10분봉 야후 X)
‘1h’:  { yahooInterval: ‘60m’, rangeDays: 30, barsKeep: 100 },  // 1시간봉 → 1개월
‘1d’:  { yahooInterval: ‘1d’,  rangeDays: 90, barsKeep: 60 }    // 일봉 → 60일
};

const cfg = config[interval] || config[‘1m’];

try {
const now = Math.floor(Date.now() / 1000);
const startTs = now - cfg.rangeDays * 86400;

```
const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${startTs}&period2=${now}&interval=${cfg.yahooInterval}&includePrePost=true`;

const yahooRes = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  }
});

if (!yahooRes.ok) {
  return res.status(502).json({ error: `Yahoo ${yahooRes.status}` });
}

const data = await yahooRes.json();

if (data?.chart?.error) {
  return res.status(502).json({ error: data.chart.error.description || '종목 없음' });
}

const result = data?.chart?.result?.[0];
if (!result) {
  return res.status(404).json({ error: '데이터 없음' });
}

const timestamps = result.timestamp || [];
const quote = result.indicators?.quote?.[0] || {};
const closes = quote.close || [];
const meta = result.meta || {};

// 유효 bars
const bars = [];
for (let i = 0; i < timestamps.length; i++) {
  if (closes[i] == null) continue;
  bars.push({
    ts: timestamps[i],
    close: +closes[i].toFixed(4)
  });
}

if (bars.length === 0) {
  return res.status(404).json({ error: '거래 데이터 없음' });
}

// 마지막 N개만 (최근)
const recent = bars.slice(-cfg.barsKeep);

// 실시간 가격 (메타에서)
const livePrice = meta.regularMarketPrice 
  || (recent[recent.length-1]?.close)
  || meta.previousClose;
const previousClose = meta.chartPreviousClose || meta.previousClose;

// 시장 상태 (시간 기반 추정)
let marketState = meta.marketState || 'UNKNOWN';
if (marketState === 'UNKNOWN') {
  const nowD = new Date();
  const month = nowD.getUTCMonth() + 1;
  const isEDT = (month >= 3 && month <= 11);
  const offset = isEDT ? -4 : -5;
  const etDate = new Date(nowD.getTime() + offset * 3600 * 1000);
  const etMin = etDate.getUTCHours() * 60 + etDate.getUTCMinutes();
  const etDay = etDate.getUTCDay();
  
  if (etDay === 0 || etDay === 6) marketState = 'CLOSED';
  else if (etMin >= 4 * 60 && etMin < 9 * 60 + 30) marketState = 'PRE';
  else if (etMin >= 9 * 60 + 30 && etMin < 16 * 60) marketState = 'REGULAR';
  else if (etMin >= 16 * 60 && etMin < 20 * 60) marketState = 'POST';
  else marketState = 'CLOSED';
}

// 변동률 (전날 종가 대비)
let changePercent = 0;
if (previousClose && livePrice) {
  changePercent = ((livePrice - previousClose) / previousClose) * 100;
}

// 캐시 짧게 (실시간이라)
const cacheTime = interval === '1m' ? 30 : (interval === '10m' ? 60 : 300);
res.setHeader('Cache-Control', `s-maxage=${cacheTime}, stale-while-revalidate=${cacheTime * 2}`);

return res.status(200).json({
  symbol: symbol,
  interval: interval,
  barCount: recent.length,
  bars: recent,
  livePrice: +livePrice.toFixed(2),
  previousClose: previousClose ? +previousClose.toFixed(2) : null,
  changePercent: +changePercent.toFixed(2),
  marketState: marketState
});
```

} catch (err) {
console.error(‘intraday.js error:’, err);
return res.status(500).json({ error: err.message || ‘서버 오류’ });
}
}