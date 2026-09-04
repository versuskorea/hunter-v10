// api/options.js - ATM 내재변동성(IV) · 야후 옵션 프록시 (크럼브 인증)
// /api/options?symbol=SOXX&days=30  →  { iv, spot, expiry, expiryDays, ivPct }
// 야후 옵션 API는 쿠키+크럼브 인증 필요 (401 방지)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

  try {
    const symbol = (req.query.symbol || 'SOXX').toUpperCase();
    const targetDays = parseInt(req.query.days || '30');

    // 1) 쿠키 받기
    let cookie = '';
    try {
      const ck = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
      const sc = ck.headers.get('set-cookie');
      if (sc) cookie = sc.split(',').map(c => c.split(';')[0]).join('; ');
    } catch (e) {}

    // 2) 크럼브 받기
    let crumb = '';
    try {
      const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA, 'Cookie': cookie }
      });
      crumb = (await cr.text()).trim();
      if (crumb.includes('<') || crumb.length > 30) crumb = '';  // HTML이면 실패
    } catch (e) {}

    const hdr = { 'User-Agent': UA, 'Cookie': cookie };
    const cp = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';

    // 3) 옵션 체인 (query1 → query2 재시도)
    let r = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}?dummy=1${cp}`, { headers: hdr });
    if (!r.ok) {
      r = await fetch(`https://query2.finance.yahoo.com/v7/finance/options/${symbol}?dummy=1${cp}`, { headers: hdr });
    }
    if (!r.ok) throw new Error('Yahoo options fetch failed: ' + r.status);

    const data = await r.json();
    const chain = data.optionChain?.result?.[0];
    if (!chain) throw new Error(`옵션 데이터 없음 [${symbol}]`);

    const spot = chain.quote?.regularMarketPrice;
    const expDates = chain.expirationDates || [];
    const now = Math.floor(Date.now() / 1000);

    let bestExp = expDates[0], bestDiff = Infinity;
    for (const e of expDates) {
      const days = (e - now) / 86400;
      if (days <= 0) continue;
      const diff = Math.abs(days - targetDays);
      if (diff < bestDiff) { bestDiff = diff; bestExp = e; }
    }

    let opt = chain.options?.[0];
    if (!opt || opt.expirationDate !== bestExp) {
      const r2 = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}?date=${bestExp}${cp}`, { headers: hdr });
      if (r2.ok) {
        const d2 = await r2.json();
        opt = d2.optionChain?.result?.[0]?.options?.[0] || opt;
      }
    }
    if (!opt) throw new Error('만기 옵션 없음');

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
      symbol, spot, iv,
      ivPct: +(iv * 100).toFixed(1),
      expiry: new Date(bestExp * 1000).toISOString().slice(0, 10),
      expiryDays,
      atmStrike: c?.strike ?? p?.strike,
      crumbOk: !!crumb
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
