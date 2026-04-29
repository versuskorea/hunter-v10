 api/quote-full.js - 종목 정보 (history.js와 완전 동일한 방식)

export default async function handler(req, res) {
const { symbol } = req.query;

if (!symbol) {
return res.status(400).json({ error: ‘symbol 파라미터 필수’ });
}

try {
const sym = String(symbol).toUpperCase().trim();

```
const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=5d&interval=1d&includePrePost=false';

const yahooRes = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  }
});

if (!yahooRes.ok) {
  return res.status(502).json({ error: 'Yahoo API ' + yahooRes.status });
}

const data = await yahooRes.json();

if (data && data.chart && data.chart.error) {
  return res.status(502).json({ error: data.chart.error.description || '종목 없음' });
}

const result = data && data.chart && data.chart.result && data.chart.result[0];
if (!result) {
  return res.status(404).json({ error: '데이터 없음' });
}

const meta = result.meta || {};
const indicators = result.indicators || {};
const quoteArr = indicators.quote || [];
const quote = quoteArr[0] || {};
const closes = quote.close || [];
const volumes = quote.volume || [];
const highs = quote.high || [];
const lows = quote.low || [];
const opens = quote.open || [];

// 최근 종가 찾기
let lastIdx = closes.length - 1;
while (lastIdx >= 0 && (closes[lastIdx] === null || closes[lastIdx] === undefined)) {
  lastIdx--;
}

let prevIdx = lastIdx - 1;
while (prevIdx >= 0 && (closes[prevIdx] === null || closes[prevIdx] === undefined)) {
  prevIdx--;
}

// 가격 결정
let price = meta.regularMarketPrice;
if (price === null || price === undefined) {
  price = lastIdx >= 0 ? closes[lastIdx] : null;
}

let previousClose = meta.chartPreviousClose;
if (previousClose === null || previousClose === undefined) {
  previousClose = meta.previousClose;
}
if (previousClose === null || previousClose === undefined) {
  previousClose = prevIdx >= 0 ? closes[prevIdx] : null;
}

let change = 0;
let changePercent = 0;
if (price !== null && previousClose !== null && previousClose > 0) {
  change = price - previousClose;
  changePercent = (change / previousClose) * 100;
}

const response = {
  symbol: meta.symbol || sym,
  longName: meta.longName || meta.shortName || sym,
  exchange: meta.fullExchangeName || meta.exchangeName || '',
  currency: meta.currency || 'USD',
  price: price,
  previousClose: previousClose,
  change: change,
  changePercent: changePercent,
  open: lastIdx >= 0 ? opens[lastIdx] : null,
  dayHigh: meta.regularMarketDayHigh || (lastIdx >= 0 ? highs[lastIdx] : null),
  dayLow: meta.regularMarketDayLow || (lastIdx >= 0 ? lows[lastIdx] : null),
  volume: meta.regularMarketVolume || (lastIdx >= 0 ? volumes[lastIdx] : 0) || 0,
  avgVolume: null,
  marketCap: null,
  sharesOutstanding: null,
  high52: meta.fiftyTwoWeekHigh || null,
  low52: meta.fiftyTwoWeekLow || null,
  change52Pct: null,
  peRatio: null,
  forwardPE: null,
  eps: null,
  beta: null,
  dividendYield: null,
  dividendRate: null,
  exDividendDate: null,
  marketTime: meta.regularMarketTime || null,
  marketState: meta.marketState || 'REGULAR'
};

res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
return res.status(200).json(response);
```

} catch (err) {
return res.status(500).json({ error: String(err.message || err) });
}
}