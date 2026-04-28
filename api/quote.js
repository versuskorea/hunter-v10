// api/quote.js - Yahoo Finance 종가 + 20일 전고 + 프리/애프터 실시간 가격
// v2: 프리/애프터 시장 가격 지원

export default async function handler(req, res) {
  const symbol = ((req.query.symbol || 'SOXL') + '').toUpperCase().trim();
  
  try {
    const now = Math.floor(Date.now() / 1000);
    const sixtyDaysAgo = now - 60 * 86400;
    
    // 🆕 includePrePost=true (프리/애프터 메타도 가져옴)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${sixtyDaysAgo}&period2=${now}&interval=1d&includePrePost=true`;
    
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
      validBars.push({ ts: timestamps[i], high: highs[i], close: closes[i] });
    }
    
    if (validBars.length === 0) {
      return res.status(404).json({ error: `${symbol} 거래 데이터 없음` });
    }
    
    const marketState = meta.marketState || 'UNKNOWN';
    const isMarketActive = ['PRE', 'REGULAR', 'POST'].includes(marketState);
    
    // 장중이면 오늘 bar 제외 (확정 종가용)
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
    
    // 확정 전날 종가 (LOC 계산용)
    const latest = confirmedBars[confirmedBars.length - 1];
    const latestDate = new Date(latest.ts * 1000).toISOString().slice(0, 10);
    const latestClose = +latest.close.toFixed(2);
    
    // 20일 전고
    const last20 = confirmedBars.slice(-20);
    const high20 = +Math.max(...last20.map(b => b.high)).toFixed(2);
    
    // 🆕 실시간 가격 (시장 상태별)
    const regularPrice = meta.regularMarketPrice ? +meta.regularMarketPrice.toFixed(2) : null;
    const preMarketPrice = meta.preMarketPrice ? +meta.preMarketPrice.toFixed(2) : null;
    const postMarketPrice = meta.postMarketPrice ? +meta.postMarketPrice.toFixed(2) : null;
    const previousClose = meta.previousClose || meta.chartPreviousClose;
    
    // 🆕 시장 상태별 "지금 보여줄 가격" 결정
    let livePrice = regularPrice || latestClose;
    let livePriceSource = 'regular';
    let livePriceLabel = '정규장';
    
    if (marketState === 'PRE' && preMarketPrice) {
      livePrice = preMarketPrice;
      livePriceSource = 'pre';
      livePriceLabel = '프리장';
    } else if (marketState === 'POST' && postMarketPrice) {
      livePrice = postMarketPrice;
      livePriceSource = 'post';
      livePriceLabel = '애프터';
    } else if (marketState === 'REGULAR' && regularPrice) {
      livePrice = regularPrice;
      livePriceSource = 'regular';
      livePriceLabel = '정규장 (장중)';
    } else if (marketState === 'CLOSED') {
      if (postMarketPrice) {
        livePrice = postMarketPrice;
        livePriceSource = 'post-closed';
        livePriceLabel = '애프터 마감';
      } else {
        livePrice = regularPrice || latestClose;
        livePriceLabel = '정규장 종가';
      }
    }
    
    // 🆕 변동률 (전날 정규장 종가 대비)
    const baseForChange = previousClose || latestClose;
    const change = livePrice - baseForChange;
    const changePercent = (change / baseForChange) * 100;
    
    // 캐시 1분 (실시간 가격이라 짧게)
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    
    return res.status(200).json({
      symbol: symbol,
      
      // 확정 종가 (LOC 계산용)
      price: latestClose,
      high20: high20,
      lastDate: latestDate,
      
      // 🆕 실시간 가격 (애프터/프리 포함)
      livePrice: livePrice,
      livePriceSource: livePriceSource,
      livePriceLabel: livePriceLabel,
      
      // 🆕 모든 가격 정보
      regularPrice: regularPrice,
      preMarketPrice: preMarketPrice,
      postMarketPrice: postMarketPrice,
      previousClose: previousClose ? +previousClose.toFixed(2) : null,
      
      // 🆕 변동률
      change: +change.toFixed(2),
      changePercent: +changePercent.toFixed(2),
      
      // 메타
      marketState: marketState,
      barCount: confirmedBars.length,
      isLive: isMarketActive,
      excludedTodayBar: excludedToday
    });
    
  } catch (err) {
    console.error('quote.js error:', err);
    return res.status(500).json({ error: err.message || '서버 오류' });
  }
}
