// api/history.js - 날짜 범위 기반!
// start/end 또는 years 받음

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const symbol = (req.query.symbol || 'SOXL').toUpperCase();
    
    // 날짜 기반 (우선)
    const start = req.query.start;
    const end = req.query.end;
    
    let url;
    if (start && end) {
      // 타임스탬프로 변환 (end는 +1일 = 마지막 거래일 봉 확실히 포함)
      const startTs = Math.floor(new Date(start).getTime() / 1000);
      const endTs = Math.floor(new Date(end).getTime() / 1000) + 86400;
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${startTs}&period2=${endTs}&interval=1d`;
    } else {
      // 기존 years 방식 (호환)
      const years = parseInt(req.query.years || '5');
      let range = '5y';
      if (years <= 1) range = '1y';
      else if (years <= 2) range = '2y';
      else if (years <= 5) range = '5y';
      else if (years <= 10) range = '10y';
      else range = 'max';
      
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;
    }
    
    // 야후가 불완전 UA에 부분/빈 응답을 주는 문제 → 완전 헤더 + query1/query2 재시도
    const YH_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const pathQuery = url.substring(url.indexOf('/v8/'));
    let data = null, lastErr = null;
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
      try {
        const r = await fetch('https://' + host + pathQuery, { headers: YH_HEADERS });
        if (!r.ok) { lastErr = 'status ' + r.status; continue; }
        const j = await r.json();
        if (j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].timestamp) {
          data = j; break;
        }
        lastErr = 'empty result';
      } catch (e) { lastErr = e.message; }
    }
    if (!data) {
      throw new Error('Yahoo fetch failed: ' + lastErr);
    }
    
    if (!data.chart || !data.chart.result || !data.chart.result[0]) {
      throw new Error(`종목 [${symbol}] 데이터 없음`);
    }
    
    const result = data.chart.result[0];
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    const closes = quotes.close;
    const opens = quotes.open;
    const highs = quotes.high;
    const lows = quotes.low;
    const volumes = quotes.volume;
    
    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null && closes[i] !== undefined) {
        bars.push({
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open: opens[i],
          high: highs[i],
          low: lows[i],
          close: closes[i],
          volume: volumes[i] || 0
        });
      }
    }
    
    return res.status(200).json({
      symbol: symbol,
      count: bars.length,
      firstDate: bars[0]?.date,
      lastDate: bars[bars.length-1]?.date,
      firstPrice: bars[0]?.close,
      lastPrice: bars[bars.length-1]?.close,
      bars: bars
    });
    
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
