// hfeed.js — 대시보드·차트 공용: 봇 활동 피드, 오늘 손익(날씨·MVP), 수익 레이스 데이터, 진입 알림
(function () {
  const now = new Date();
  const hOf = tz => +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now);
  const OFF = (hOf('Asia/Seoul') - hOf('America/New_York') + 24) % 24;          // ET → 한국 시각 차이
  const hm = s => { const m = String(s || '').match(/(\d\d):(\d\d)/); return m ? +m[1] * 60 + +m[2] : null; };
  // ET 날짜+시각 → 정렬용 숫자(분)와 한국 시각 글자
  const at = (d, t) => {
    if (!d) return null;
    const m = hm(t); const base = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 60000;
    const k = base + (m == null ? 16 * 60 : m) + OFF * 60;                                // 한국 시각(분, UTC 기준 표기)
    const dt = new Date(k * 60000);
    return { ts: k, txt: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()} ${String(dt.getUTCHours()).padStart(2, '0')}:${String(dt.getUTCMinutes()).padStart(2, '0')}` };
  };
  const f2 = x => x == null || !isFinite(x) ? '–' : Number(x).toFixed(2);
  const usd = x => (x < 0 ? '−$' : '+$') + Math.round(Math.abs(x)).toLocaleString('en-US');
  const krw = x => (x < 0 ? '−' : '+') + (Math.abs(x) >= 1e8 ? (Math.abs(x) / 1e8).toFixed(2) + '억' : Math.round(Math.abs(x) / 1e4).toLocaleString() + '만');

  // ── 활동 피드: [{ts, when, icon, text, pnl(원), tone}]
  function feed(j) {
    const out = [], fx = j.fx || (j.mnq && j.mnq.cfg && +j.mnq.cfg.fx) || 1400;
    const push = (w, icon, text, pnl, extra) => { if (w) out.push({ ts: w.ts, when: w.txt, icon, text, pnl: pnl == null ? null : pnl, ...(extra || {}) }); };
    const w = j.wave || {};
    for (const t of w.trades || []) {
      const side = t.sym === 'SOXS' ? '숏' : '롱';
      push(at(t.d, t.in), '🌊', `웨이브 ${side} 진입 · ${t.sym} ${(+t.q || 0).toLocaleString()}주 @${f2(t.e)}`, null, { kind: 'in' });
      const ot = /15:50/.test(t.out) ? '15:50' : t.out;
      push(at(t.d, ot), '🌊', `웨이브 ${side} 청산 · ${f2(t.e)}→${f2(t.x)}`, (+t.pnl || 0) * fx, { usd: +t.pnl });
    }
    if (+w.pos && w.day) push(at(w.day, w.entry_t), '🌊', `웨이브 ${+w.pos > 0 ? '롱' : '숏'} 보유 중 · ${w.sym} ${(+w.qty).toLocaleString()}주 @${f2(w.entry)}`, null, { kind: 'in' });
    const m = j.mnq || {};
    for (const h of m.history || []) {
      push(at(h.date, '16:00'), '📈', `MNQ ${h.m === 'atk' ? '공격' : '방어'} 매수 ${h.qty}계약 @${Number(h.entry).toLocaleString()}`, null, { kind: 'in' });
      push(at(h.exit_date, '16:00'), '📈', `MNQ 매도 @${Number(h.exit).toLocaleString()} · ${h.reason || ''}`, +h.pnl_krw || 0);
    }
    for (const p of m.positions || []) push(at(p.date, '16:00'), '📈', `MNQ 보유 · ${p.qty}계약 @${Number(p.entry).toLocaleString()}`, null, { kind: 'in' });
    const mi = j.mnqIntra || {};
    for (const t of mi.trades || []) {
      const side = +t.side > 0 ? '롱' : '숏';
      push(at(t.d, t.in), '🌀', `MNQ 웨이브 ${side} 진입 ${t.q}계약 @${Number(t.e).toLocaleString()}`, null, { kind: 'in' });
      push(at(t.d, String(t.out).slice(0, 5)), '🌀', `MNQ 웨이브 ${side} 청산 @${Number(t.x).toLocaleString()}`, +t.pnl || 0);
    }
    const bs = (j.bo && j.bo.state) || {}, pl = bs.plan || {};
    if (pl.date) push(at(pl.date, '09:30'), '🚀', pl.status === 'skip' ? `계좌2 돌파 쉼 · ${pl.why || ''}` : `계좌2 돌파 대기 · 돌파가 ${f2(pl.level)}`, null);
    if (bs.pos && bs.pos.entry) push(at(bs.pos.date, '12:00'), '🚀', `계좌2 돌파 매수 ${bs.pos.qty || ''}주 @${f2(bs.pos.entry)}`, null, { kind: 'in' });
    if (bs.errMsg) push(at(pl.date || null, '09:31'), '⚠️', `계좌2: ${bs.errMsg}`, null, { warn: 1 });
    const ns = (j.night && j.night.state) || {};
    if (ns.planMsg && ns.day && ns.day.date) push(at(String(ns.day.date).slice(0, 10), '16:01'), '🌙', `밤 돌파 · ${ns.planMsg}`, null);
    const mr = (j.manual && j.manual.raw) || {};
    if (mr.errs) out.push({ ts: Infinity, when: '지금', icon: '⚠️', text: `웅덩이 ${mr.errs}`, pnl: null, warn: 1 });
    for (const [k, st] of Object.entries(mr.rules || {})) if (st.st === 'hold' && st.day) push(at(st.day, '12:00'), '🕳', `웅덩이 진입 · ${k.split(' ')[0]} ${((st.bought || 0) - (st.sold || 0)).toLocaleString()}주 @${f2(st.avg)}`, null, { kind: 'in' });
    const p = j.sniper && j.sniper.plan;
    if (p && p.date) push(at(p.date, '09:00'), '🎯', `스나이퍼 주문표 ${p.date.slice(5)} · ${p.mode === 'def' ? '방어' : '공격'} · ${(p.rows || []).length}건${p.placed ? ' 접수' : ''}`, null);
    return out.filter(x => x.ts != null).sort((a, b) => b.ts - a.ts);
  }

  // ── 오늘(최근 장) 전략별 손익(원) → 날씨·MVP
  function today(j) {
    const fx = j.fx || 1400, px = j.px || {}, L = s => px[s] && px[s].last, P = s => px[s] && px[s].prev;
    const day = (j.mnq && j.mnq.last_date) || (j.wave && j.wave.day) || '';
    const w = j.wave || {}, r = {};
    const h1 = (j.acct1 && j.acct1.hold) || {}, h2 = (j.acct2 && j.acct2.hold) || {};
    const wq = s => (+w.pos && w.sym === s) ? +w.qty || 0 : 0;
    if (L('SOXL') && P('SOXL')) {
      r['🎯 스나이퍼'] = Math.max(0, ((h1.SOXL || {}).qty || 0) - wq('SOXL')) * (L('SOXL') - P('SOXL')) * fx;
      r['🚀 계좌2 돌파'] = ((h2.SOXL || {}).qty || 0) * (L('SOXL') - P('SOXL')) * fx;
    }
    let wv = (w.trades || []).filter(t => t.d === day).reduce((a, t) => a + (+t.pnl || 0), 0);
    if (+w.pos && L(w.sym)) wv += (L(w.sym) - w.entry) * w.qty;
    r['🌊 SOXL 웨이브'] = wv * fx;
    const m = j.mnq || {}, cf = m.cfg || {};
    if (L('MNQ') && P('MNQ')) r['📈 MNQ'] = (m.positions || []).reduce((a, q) => a + (+q.qty || 1), 0) * (L('MNQ') - P('MNQ')) * 2 * (+cf.fx || 1360);
    const mi = j.mnqIntra || {};
    r['🌀 MNQ 웨이브'] = (mi.trades || []).filter(t => t.d === day).reduce((a, t) => a + (+t.pnl || 0), 0);
    let pit = 0; for (const st of Object.values(((j.manual || {}).raw || {}).rules || {})) if (st.st === 'hold' && L('SOXL')) pit += ((st.bought || 0) - (st.sold || 0)) * (L('SOXL') - st.avg) * fx;
    if (pit) r['🕳 웅덩이'] = pit;
    const tot = Object.values(r).reduce((a, b) => a + b, 0);
    const mvp = Object.entries(r).sort((a, b) => b[1] - a[1])[0];
    return { day, by: r, tot, mvp };
  }
  function weather(pct) {
    if (pct >= 2) return ['☀️', '쨍쨍', '#fbbf24'];
    if (pct >= 0.3) return ['🌤', '맑음', '#fcd34d'];
    if (pct > -0.3) return ['⛅', '잔잔', '#9ca3af'];
    if (pct > -2) return ['🌧', '비', '#60a5fa'];
    if (pct > -5) return ['⛈', '폭풍', '#a78bfa'];
    return ['🌪', '태풍', '#f87171'];
  }

  // ── 수익 레이스: {name: [[date, 누적원]]}
  function race(j) {
    const fx = j.fx || (j.mnq && j.mnq.cfg && +j.mnq.cfg.fx) || 1400, S = {};
    const cum = (arr, dOf, vOf) => { const by = {}; for (const a of arr) { const d = dOf(a); if (d) by[d] = (by[d] || 0) + vOf(a); } let c = 0; return Object.keys(by).sort().map(d => [d, c += by[d]]); };
    S['🌊 SOXL 웨이브'] = { c: '#60a5fa', pts: cum((j.wave || {}).trades || [], t => t.d, t => (+t.pnl || 0) * fx) };
    S['📈 MNQ'] = { c: '#22c55e', pts: cum((j.mnq || {}).history || [], h => h.exit_date, h => +h.pnl_krw || 0) };
    S['🌀 MNQ 웨이브'] = { c: '#fbbf24', pts: cum((j.mnqIntra || {}).trades || [], t => t.d, t => +t.pnl || 0) };
    const dl = j.daily || {}, ks = Object.keys(dl).sort();
    const from = (k, f) => { const b = ks.find(d => dl[d][k] != null); if (!b) return []; return ks.filter(d => dl[d][k] != null && d >= b).map(d => [d, f(dl[d]) - f(dl[b])]); };
    S['🎯 스나이퍼 장부'] = { c: '#f87171', pts: from('sn', x => x.sn * (x.fx || fx)) };
    S['🚀 계좌2'] = { c: '#a78bfa', pts: from('a2', x => x.a2 * (x.fx || fx)) };
    return S;
  }

  // ── 진입 알림: 이전에 없던 보유가 생기면 true + 내용
  function entries(j) {
    const s = [];
    const w = j.wave || {}; if (+w.pos) s.push(`🌊 웨이브 ${+w.pos > 0 ? '롱' : '숏'} ${w.sym} @${f2(w.entry)}|${w.day}${w.entry_t}`);
    for (const p of (j.mnq || {}).positions || []) s.push(`📈 MNQ ${p.qty}계약 @${p.entry}|${p.date}`);
    const mi = j.mnqIntra || {}; if (+mi.pos) s.push(`🌀 MNQ 웨이브 ${+mi.pos > 0 ? '롱' : '숏'} @${mi.entry}|${mi.day}${mi.entry_t}`);
    const bs = (j.bo && j.bo.state) || {}; if (bs.pos && bs.pos.qty) s.push(`🚀 계좌2 돌파 ${bs.pos.qty}주 @${f2(bs.pos.entry)}|${bs.pos.date}`);
    const ns = (j.night && j.night.state) || {}; if (ns.pos && ns.pos.qty) s.push(`🌙 밤 돌파 ${ns.pos.qty}주|${ns.pos.date || ''}`);
    for (const [k, st] of Object.entries(((j.manual || {}).raw || {}).rules || {})) if (st.st === 'hold') s.push(`🕳 웅덩이 ${k.split(' ')[0]} @${f2(st.avg)}|${st.day}${st.lastSig || ''}`);
    return s;
  }
  function alertNew(j) {
    const cur = entries(j); let prev = null;
    try { prev = JSON.parse(sessionStorage.getItem('hEntries') || 'null'); sessionStorage.setItem('hEntries', JSON.stringify(cur)); } catch { }
    if (!prev) return;
    const nu = cur.filter(x => !prev.includes(x));
    if (nu.length) flash(nu.map(x => x.split('|')[0]));
  }
  function flash(lines) {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:radial-gradient(circle,#22c55e66,#08080aee 70%);color:#fff;font:700 22px -apple-system,sans-serif;text-align:center;padding:20px;animation:hfl .25s ease 4 alternate';
    o.innerHTML = '<div style="font-size:54px">🚨</div><div>봇 진입!</div>' + lines.map(l => `<div style="font-size:16px;font-weight:600">${l.replace(/</g, '&lt;')}</div>`).join('') + '<div style="font-size:12px;opacity:.7;margin-top:10px">눌러서 닫기</div>';
    if (!document.getElementById('hflk')) { const st = document.createElement('style'); st.id = 'hflk'; st.textContent = '@keyframes hfl{from{opacity:.55}to{opacity:1}}'; document.head.appendChild(st); }
    o.onclick = () => o.remove(); document.body.appendChild(o); setTimeout(() => o.remove(), 6000);
    try { navigator.vibrate && navigator.vibrate([200, 100, 200, 100, 300]); } catch { }
    try { const A = new (window.AudioContext || window.webkitAudioContext)(); [0, .18, .36].forEach((t, i) => { const g = A.createGain(), os = A.createOscillator(); os.frequency.value = [880, 1100, 1320][i]; g.gain.value = .15; os.connect(g); g.connect(A.destination); os.start(A.currentTime + t); os.stop(A.currentTime + t + .14); }); } catch { }
  }

  window.HF = { feed, today, weather, race, alertNew, flash, krw, usd };
})();
