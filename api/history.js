// api/history.js — 날짜 범위 + interval(일봉/분봉) 지원
// 예) /api/history?symbol=NQ%3DF&start=2026-09-01&end=2026-09-16
//     /api/history?symbol=NQ%3DF&start=2026-09-03&end=2026-09-16&interval=5m
//     /api/history?symbol=SOXL&years=10

const ALLOWED = new Set(['1m','2m','5m','15m','30m','60m','90m','1h','1d','1wk','1mo']);
const MAX_DAYS = { '1m':7, '2m':60, '5m':60, '15m':60, '30m':60, '60m':730, '90m':60, '1h':730 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const symbol = (req.query.symbol || 'SOXL').toUpperCase();

    let interval = String(req.query.interval || '1d').toLowerCase();
    if (!ALLOWED.has(interval)) interval = '1d';
    const intraday = interval !== '1d' && interval !== '1wk' && interval !== '1mo';

    const start = req.query.start;
    const end = req.query.end;

    let url;
    if (start && end) {
      let startTs = Math.floor(new Date(start).getTime() / 1000);
      let endTs = Math.floor(new Date(end).getTime() / 1000);
      if (!isFinite(startTs) || !isFinite(endTs)) throw new Error('Invalid date');
      if (intraday) endTs += 86399;          // 분봉은 마지막 날 장 마감까지 포함

      const lim = MAX_DAYS[interval];
      if (lim) {
        const minStart = endTs - lim * 86400 + 3600;
        if (startTs < minStart) startTs = minStart;
      }
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
          + `?period1=${startTs}&period2=${endTs}&interval=${interval}`;
    } else {
      const years = parseInt(req.query.years || '5');
      let range = 'max';
      if (intraday) range = (interval === '1m') ? '5d' : '1mo';
      else if (years <= 1) range = '1y';
      else if (years <= 2) range = '2y';
      else if (years <= 5) range = '5y';
      else if (years <= 10) range = '10y';
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
          + `?range=${range}&interval=${interval}`;
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'application/json'
      }
    });
    if (!response.ok) throw new Error('Yahoo fetch failed: ' + response.status);

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      const y = data?.chart?.error?.description;
      throw new Error(y || `종목 [${symbol}] 데이터 없음`);
    }

    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const closes = q.close || [], opens = q.open || [], highs = q.high || [],
          lows = q.low || [], volumes = q.volume || [];

    const fmtDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const fmtTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false
    });

    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c === null || c === undefined) continue;
      const d = new Date(timestamps[i] * 1000);
      // 일봉은 기존과 동일한 UTC 날짜(하위호환), 분봉만 ET 날짜
      const dateStr = intraday ? fmtDate.format(d) : d.toISOString().slice(0, 10);
      bars.push({
        date: dateStr,
        ts: timestamps[i],
        etTime: fmtTime.format(d),
        open: opens[i], high: highs[i], low: lows[i],
        close: c, volume: volumes[i] || 0
      });
    }

    return res.status(200).json({
      symbol, interval, count: bars.length,
      firstDate: bars[0] && bars[0].date,
      lastDate: bars[bars.length - 1] && bars[bars.length - 1].date,
      firstPrice: bars[0] && bars[0].close,
      lastPrice: bars[bars.length - 1] && bars[bars.length - 1].close,
      bars
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
