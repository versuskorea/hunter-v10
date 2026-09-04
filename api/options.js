// api/options.js - ATM 내재변동성(IV) · 야후 옵션 프록시
// /api/options?symbol=SOXX&days=30  →  { iv, spot, expiry, expiryDays, atmStrike }
// iv는 소수 (0.32 = 32%). history.js와 같은 야후·같은 방식.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

  try {
    const symbol = (req.query.symbol || 'SOXX').toUpperCase();
    const targetDays = parseInt(req.query.days || '30');
    const base = `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`;

    // 1) 만기 목록 + 현재가 (첫 호출)
    let r = await fetch(base, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('Yahoo options fetch failed: ' + r.status);
    let data = await r.json();
    let chain = data.optionChain?.result?.[0];
    if (!chain) throw new Error(`옵션 데이터 없음 [${symbol}]`);

    const spot = chain.quote?.regularMarketPrice;
    const expDates = chain.expirationDates || [];
    const now = Math.floor(Date.now() / 1000);

    // 2) 목표일수(30일) 근처 만기 찾기
    let bestExp = expDates[0], bestDiff = Infinity;
    for (const e of expDates) {
      const days = (e - now) / 86400;
      if (days <= 0) continue;
      const diff = Math.abs(days - targetDays);
      if (diff < bestDiff) { bestDiff = diff; bestExp = e; }
    }

    // 3) 그 만기 옵션 체인 (첫 응답이 다른 만기면 재호출)
    let opt = chain.options?.[0];
    if (!opt || opt.expirationDate !== bestExp) {
      r = await fetch(`${base}?date=${bestExp}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('Yahoo options(date) failed: ' + r.status);
      data = await r.json();
      opt = data.optionChain?.result?.[0]?.options?.[0];
    }
    if (!opt) throw new Error('만기 옵션 없음');

    // 4) ATM strike IV (현재가에 가장 가까운 strike, call+put 평균)
    const pickATM = (arr) => {
      if (!arr || !arr.length) return null;
      let best = null, bd = Infinity;
      for (const o of arr) {
        if (o.impliedVolatility == null || o.impliedVolatility <= 0) continue;
        const d = Math.abs(o.strike - spot);
        if (d < bd) { bd = d; best = o; }
      }
      return best;
    };
    const c = pickATM(opt.calls);
    const p = pickATM(opt.puts);
    const ivs = [c?.impliedVolatility, p?.impliedVolatility].filter(v => v != null);
    if (!ivs.length) throw new Error('IV 없음');
    const iv = ivs.reduce((a, b) => a + b, 0) / ivs.length;

    const expiryDays = Math.round((bestExp - now) / 86400);
    return res.status(200).json({
      symbol,
      spot,
      iv,                     // 소수 (0.32 = 32%)
      ivPct: +(iv * 100).toFixed(1),
      expiry: new Date(bestExp * 1000).toISOString().slice(0, 10),
      expiryDays,
      atmStrike: c?.strike ?? p?.strike
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
