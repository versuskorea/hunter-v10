// api/quote.js v3 - 진짜 실시간 가격 (프리/애프터/정규장)
// 일봉 + 1분봉 두 번 호출하여 정확한 실시간 가격 추출

export default async function handler(req, res) {
const symbol = ((req.query.symbol || ‘SOXL’) + ‘’).toUpperCase().trim();

try {
const now = Math.floor(Date.now() / 1000);
const sixtyDaysAgo = now - 60 * 86400;
const fiveDaysAgo = now - 5 * 86400;

```
// 🆕 두 API 동시 호출
const dailyUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${sixtyDaysAgo}&period2=${now}&interval=1d&includePrePost=true`;
const minuteUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${fiveDaysAgo}&period2=${now}&interval=1m&includePrePost=true`;

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

const [dailyRes, minuteRes] = await Promise.all([
  fetch(dailyUrl, { headers }),
  fetch(minuteUrl, { headers })
]);

if (!dailyRes.ok) {
  return res.status(502).json({ error: `Yahoo Daily API ${dailyRes.status}` });
}

const dailyData = await dailyRes.json();

if (dailyData?.chart?.error) {
  return res.status(502).json({ error: dailyData.chart.error.description || `${symbol} 종목 없음` });
}

const dailyResult = dailyData?.chart?.result?.[0];
if (!dailyResult) {
  return res.status(404).json({ error: `${symbol} 데이터 없음` });
}

const dailyTimestamps = dailyResult.timestamp || [];
const dailyQuote = dailyResult.indicators?.quote?.[0] || {};
const dailyHighs = dailyQuote.high || [];
const dailyCloses = dailyQuote.close || [];
const dailyMeta = dailyResult.meta || {};

const dailyBars = [];
for (let i = 0; i < dailyTimestamps.length; i++) {
  if (dailyCloses[i] == null || dailyHighs[i] == null) continue;
  dailyBars.push({ ts: dailyTimestamps[i], high: dailyHighs[i], close: dailyCloses[i] });
}

if (dailyBars.length === 0) {
  return res.status(404).json({ error: `${symbol} 거래 데이터 없음` });
}

// 🆕 marketState - meta에서 가져오거나 시간으로 추정
let marketState = dailyMeta.marketState || 'UNKNOWN';

// marketState가 UNKNOWN이면 시간으로 추정 (US Eastern Time)
if (marketState === 'UNKNOWN') {
  const nowUTC = new Date();
  // ET = UTC-5 (EST) 또는 UTC-4 (EDT). 4월~10월은 EDT
  const month = nowUTC.getUTCMonth() + 1;
  const isEDT = (month >= 3 && month <= 11);
  const offset = isEDT ? -4 : -5;
  const etDate = new Date(nowUTC.getTime() + offset * 3600 * 1000);
  const etHour = etDate.getUTCHours();
  const etMin = etDate.getUTCMinutes();
  const etMinutes = etHour * 60 + etMin;
  const etDay = etDate.getUTCDay(); // 0=Sun, 6=Sat
  
  if (etDay === 0 || etDay === 6) {
    marketState = 'CLOSED';  // 주말
  } else if (etMinutes >= 4 * 60 && etMinutes < 9 * 60 + 30) {
    marketState = 'PRE';     // 04:00 ~ 09:30 ET
  } else if (etMinutes >= 9 * 60 + 30 && etMinutes < 16 * 60) {
    marketState = 'REGULAR'; // 09:30 ~ 16:00 ET
  } else if (etMinutes >= 16 * 60 && etMinutes < 20 * 60) {
    marketState = 'POST';    // 16:00 ~ 20:00 ET
  } else {
    marketState = 'CLOSED';
  }
}

const isMarketActive = ['PRE', 'REGULAR', 'POST'].includes(marketState);

// 장중이면 오늘 bar 제외 (확정 종가용)
let confirmedBars = dailyBars;
let excludedToday = false;

if (isMarketActive && dailyBars.length >= 2) {
  try {
    const lastBarTs = dailyBars[dailyBars.length - 1].ts;
    const lastBarDate = new Date(lastBarTs * 1000).toISOString().slice(0, 10);
    const todayUTC = new Date();
    const usEastDate = new Date(todayUTC.getTime() - 4 * 3600 * 1000).toISOString().slice(0, 10);
    
    if (lastBarDate === usEastDate) {
      confirmedBars = dailyBars.slice(0, -1);
      excludedToday = true;
    }
  } catch (e) {
    confirmedBars = dailyBars;
  }
}

if (confirmedBars.length === 0) {
  confirmedBars = dailyBars;
  excludedToday = false;
}

// 확정 전날 종가 (LOC 계산용)
const latest = confirmedBars[confirmedBars.length - 1];
const latestDate = new Date(latest.ts * 1000).toISOString().slice(0, 10);
const latestClose = +latest.close.toFixed(2);

// 20일 전고
const last20 = confirmedBars.slice(-20);
const high20 = +Math.max(...last20.map(b => b.high)).toFixed(2);

// 🆕 1분봉에서 진짜 실시간 가격 추출
let livePrice = latestClose;
let livePriceSource = 'fallback';
let livePriceLabel = '확정 종가';
let preMarketPrice = null;
let postMarketPrice = null;
let regularPrice = null;

if (minuteRes.ok) {
  try {
    const minuteData = await minuteRes.json();
    const minuteResult = minuteData?.chart?.result?.[0];
    
    if (minuteResult) {
      const minuteTimestamps = minuteResult.timestamp || [];
      const minuteQuote = minuteResult.indicators?.quote?.[0] || {};
      const minuteCloses = minuteQuote.close || [];
      
      // 오늘 날짜 (US Eastern)
      const todayET = new Date();
      const offset = -4 * 3600 * 1000; // EDT
      const todayETDate = new Date(todayET.getTime() + offset).toISOString().slice(0, 10);
      
      // 오늘 분봉만 필터
      const todayBars = [];
      for (let i = 0; i < minuteTimestamps.length; i++) {
        if (minuteCloses[i] == null) continue;
        const barDate = new Date(minuteTimestamps[i] * 1000).toISOString().slice(0, 10);
        if (barDate === todayETDate) {
          todayBars.push({ ts: minuteTimestamps[i], close: minuteCloses[i] });
        }
      }
      
      // 마지막 거래된 가격 = 실시간
      if (todayBars.length > 0) {
        const lastBar = todayBars[todayBars.length - 1];
        livePrice = +lastBar.close.toFixed(2);
        
        // 시간으로 분봉 분류
        const lastBarET = new Date((lastBar.ts + offset / 1000) * 1000);
        const lastBarMins = lastBarET.getUTCHours() * 60 + lastBarET.getUTCMinutes();
        
        if (lastBarMins < 9 * 60 + 30) {
          preMarketPrice = livePrice;
          livePriceSource = 'pre';
          livePriceLabel = '프리장';
        } else if (lastBarMins < 16 * 60) {
          regularPrice = livePrice;
          livePriceSource = 'regular';
          livePriceLabel = '정규장 (장중)';
        } else {
          postMarketPrice = livePrice;
          livePriceSource = 'post';
          livePriceLabel = marketState === 'CLOSED' ? '애프터 마감' : '애프터';
        }
        
        // 정규장 종가도 따로 추출 (분봉에서)
        for (let i = todayBars.length - 1; i >= 0; i--) {
          const bar = todayBars[i];
          const barET = new Date((bar.ts + offset / 1000) * 1000);
          const barMins = barET.getUTCHours() * 60 + barET.getUTCMinutes();
          if (barMins >= 9 * 60 + 30 && barMins <= 16 * 60) {
            regularPrice = +bar.close.toFixed(2);
            break;
          }
        }
      } else if (marketState === 'CLOSED' || marketState === 'UNKNOWN') {
        // 오늘 장 데이터 없음 = 주말/공휴일/장 마감 후
        livePrice = latestClose;
        livePriceLabel = '정규장 종가';
        livePriceSource = 'regular';
        regularPrice = latestClose;
      }
    }
  } catch (e) {
    // 분봉 실패 시 일봉 종가 사용
    livePrice = latestClose;
  }
}

// 🆕 변동률 (전날 정규장 종가 대비)
// previousClose = 전날 종가 = confirmedBars의 직전 영업일 종가
let previousClose = latestClose;  // 기본값
if (excludedToday && confirmedBars.length >= 1) {
  // 오늘 bar 제외했으면 confirmedBars 마지막이 어제
  previousClose = latestClose;  // 어제 종가
} else if (!excludedToday && confirmedBars.length >= 2) {
  // 오늘 bar 안 제외했으면 confirmedBars[length-2]가 어제
  previousClose = +confirmedBars[confirmedBars.length - 2].close.toFixed(2);
}

const change = livePrice - previousClose;
const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

// 캐시 1분 (실시간이라 짧게)
res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

return res.status(200).json({
  symbol: symbol,
  
  // 확정 종가 (LOC 계산용)
  price: latestClose,            // 전날 확정 종가
  high20: high20,
  lastDate: latestDate,
  
  // 🆕 실시간 가격
  livePrice: livePrice,
  livePriceSource: livePriceSource,
  livePriceLabel: livePriceLabel,
  
  // 🆕 모든 가격 정보
  regularPrice: regularPrice,
  preMarketPrice: preMarketPrice,
  postMarketPrice: postMarketPrice,
  previousClose: previousClose,
  
  // 🆕 변동률 (전날 종가 대비)
  change: +change.toFixed(2),
  changePercent: +changePercent.toFixed(2),
  
  // 메타
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