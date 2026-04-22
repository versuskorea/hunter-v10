// api/quote.js - Vercel Serverless Function
// ⭐ v9: 종목 선택 가능! (?symbol=POET)
// 어떤 종목이든 가능: SOXL, POET, TSLA, TQQQ, NVDA 등

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    // ⭐ 종목 파라미터 (기본: SOXL)
    const symbol = (req.query.symbol || 'SOXL').toUpperCase();
    
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=2mo&interval=1d`;
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
      throw new Error(`종목 코드 [${symbol}] 확인 필요`);
    }
    
    const result = data.chart.result[0];
    const meta = result.meta;
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    const closes = quotes.close;
    
    const validData = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null && closes[i] !== undefined) {
        validData.push({
          ts: timestamps[i],
          close: closes[i],
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
        });
      }
    }
    
    const todayUTC = new Date().toISOString().slice(0, 10);
    const marketState = meta.marketState;
    const isMarketOpen = marketState === 'REGULAR' || marketState === 'PRE';
    
    let confirmedData = validData;
    if (isMarketOpen && validData.length > 0) {
      const lastDate = validData[validData.length - 1].date;
      if (lastDate === todayUTC) {
        confirmedData = validData.slice(0, -1);
      }
    }
    
    if (confirmedData.length === 0) {
      throw new Error('No confirmed close data');
    }
    
    const lastClose = confirmedData[confirmedData.length - 1].close;
    const lastDate = confirmedData[confirmedData.length - 1].date;
    const last20Closes = confirmedData.slice(-20).map(d => d.close);
    const high20 = Math.max(...last20Closes);
    const drawdown = ((lastClose - high20) / high20 * 100).toFixed(2);
    
    let zone;
    if (drawdown >= -10) zone = 'top';
    else if (drawdown <= -15) zone = 'bot';
    else zone = 'mid';
    
    return res.status(200).json({
      symbol: symbol,
      price: parseFloat(lastClose.toFixed(2)),
      high20: parseFloat(high20.toFixed(2)),
      drawdown: parseFloat(drawdown),
      zone: zone,
      lastDate: lastDate,
      marketState: marketState,
      marketOpen: isMarketOpen,
      dataPoints: confirmedData.length,
      note: '확정 종가만 사용 · v9 다종목',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      hint: '종목 코드 확인 (대문자), 또는 야후 API 실패'
    });
  }
}
