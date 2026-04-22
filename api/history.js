// api/history.js - 백테용 장기 데이터
// 종목의 과거 N년 일봉 데이터를 가져옴

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    const symbol = (req.query.symbol || 'SOXL').toUpperCase();
    const years = parseInt(req.query.years || '5');
    
    // 야후 파이낸스: range 지정
    // 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, max
    let range = '5y';
    if (years <= 1) range = '1y';
    else if (years <= 2) range = '2y';
    else if (years <= 5) range = '5y';
    else if (years <= 10) range = '10y';
    else range = 'max';
    
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    });
    
    if (!response.ok) {
      throw new Error('Yahoo fetch failed: ' + response.status);
    }
    
    const data = await response.json();
    
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
    
    // 유효 데이터만 (null 제외)
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
      range: range,
      count: bars.length,
      firstDate: bars[0]?.date,
      lastDate: bars[bars.length-1]?.date,
      firstPrice: bars[0]?.close,
      lastPrice: bars[bars.length-1]?.close,
      bars: bars,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      hint: '종목 코드 확인 또는 야후 API 실패'
    });
  }
}
