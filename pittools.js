// pittools.js — 웅덩이 조건주문 줄 (목록 · 켜기/끄기 · 지우기 · 새 줄 · 매도 줄). 메인 대시보드와 같은 문법·같은 저장(/api/settings MANUAL)
// 사용: PT.mount(boxEl, manual)   manual = /api/dash 의 manual ({ lines, raw: { rules } })
(function () {
  const css = `
.pt .pl{display:flex;align-items:center;gap:8px;padding:7px 14px;border-bottom:1px dashed #1e2436}
.pt .pl .t{flex:1;font-size:12px;word-break:break-all;font-family:'JetBrains Mono',monospace}.pt .pl.off .t{color:#5a6278;text-decoration:line-through}
.pt .sw{flex:none;width:40px;height:24px;border-radius:99px;border:0;background:#2a3147;position:relative;padding:0}
.pt .sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#8a93a8;transition:left .15s}
.pt .sw.on{background:#3ddc97}.pt .sw.on::after{left:19px;background:#fff}
.pt .xb{flex:none;border:0;background:#2a1820;color:#ff8a9a;border-radius:8px;width:30px;height:28px;font-size:13px}
.pt .pst{font-size:12px;white-space:nowrap;color:#8a93a8}.pt .pst.up{color:#22c55e}
.pt .ds{font-size:11px;color:#8a93a8;margin-top:2px;font-family:-apple-system,sans-serif}
.pt .nb{margin:0;padding:12px 14px;border-top:1px solid #222233}
.pt .nb .h{font-size:11.5px;color:#8a93a8}
.pt .g{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:6px}
.pt label{display:block;font-size:10.5px;color:#8a93a8;margin-bottom:2px}
.pt input,.pt select{width:100%;box-sizing:border-box;padding:7px;border-radius:9px;border:1px solid #222233;background:#0f1320;color:#f0f0f0;font-size:14px}
.pt .ob{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.pt .ob button{border:1px solid #222233;background:#0f1320;color:#8a93a8;border-radius:99px;padding:5px 10px;font-size:12px}
.pt .ob button.on{border-color:#3b82f6;color:#fff;background:#231c40}
.pt .pv{font-family:'JetBrains Mono',monospace;font-size:11px;color:#fbbf24;margin-top:8px;word-break:break-all}
.pt .btn{width:100%;margin-top:10px;padding:10px 16px;border-radius:12px;border:0;background:#3b82f6;color:#fff;font-size:15px;font-weight:700}
.pt .msg{padding:0 14px 12px;font-size:12px}.pt .msg.ok{color:#22c55e}.pt .msg.err{color:#fbbf24}
.pt .none{padding:14px;color:#666;font-size:12px}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f2 = x => x == null || isNaN(x) ? '–' : Number(x).toFixed(2);
  const getPin = () => { try { return localStorage.getItem('dashPin') || sessionStorage.getItem('dashPin') || ''; } catch { return ''; } };
  let LINES = [], R = {}, BUSY = false, root = null;
  const OPT = { RTH: false, EOD: false, REPEAT: true }, SOPT = { EOD: false };
  const q = s => root.querySelector(s);

  function list() {
    const el = q('.lines');
    el.innerHTML = LINES.length ? LINES.map((l, i) => {
      const off = l.startsWith('#'), t = off ? l.replace(/^#\s*/, '') : l, s = R[l] || {};
      const held = (s.bought || 0) - (s.sold || 0);
      const lab = off ? '꺼짐' : s.st === 'hold' ? `보유 ${held.toLocaleString()}주` : s.st === 'done' ? '끝' : (s.st || '대기');
      const det = s.st === 'hold' ? `<div class="ds">평단 ${f2(s.avg)} · 손절 ${f2(s.slPx)}${s.halfPx && !s.halfDone ? ' · 절반 ' + f2(s.halfPx) : ''}${s.tpPx ? ' · 익절 ' + f2(s.tpPx) : ''}</div>` : '';
      return `<div class="pl ${off ? 'off' : ''}"><button class="sw ${off ? '' : 'on'}" data-tog="${i}" aria-label="켜기/끄기"></button><div class="t">${esc(t)}${det}</div><span class="pst ${s.st === 'hold' ? 'up' : ''}">${esc(lab)}</span><button class="xb" data-del="${i}" aria-label="지우기">✕</button></div>`;
    }).join('') : '<div class="none">등록된 줄 없음</div>';
    el.querySelectorAll('[data-tog]').forEach(b => b.onclick = () => { const i = +b.dataset.tog, l = LINES[i]; LINES[i] = l.startsWith('#') ? l.replace(/^#\s*/, '') : '# ' + l; save(LINES[i].startsWith('#') ? '끔' : '켬'); });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { const i = +b.dataset.del; if (!confirm('이 줄을 지울까요?\n' + LINES[i])) return; LINES.splice(i, 1); save('지움'); });
    const c = document.getElementById('ptCount'); if (c) c.textContent = LINES.length + '줄';
  }
  function msg(t, err) { const m = q('.msg'); m.textContent = t; m.className = 'msg ' + (err ? 'err' : 'ok'); }
  async function save(m) {
    BUSY = true; list(); msg('저장 중…');
    try {
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'x-pin': getPin(), 'content-type': 'application/json' }, body: JSON.stringify({ set: { MANUAL: LINES.join('\n') } }) });
      const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || r.status);
      msg(m + ' · 1분 안에 봇이 읽어요');
    } catch (e) { msg('저장 실패: ' + (e.message || e) + ' · 원래대로 다시 불러옴', 1); BUSY = false; refresh(); return; }
    BUSY = false;
  }
  function build() {
    const s = q('#nSym').value, tf = q('#nTf').value, n = Math.max(1, +q('#nQty').value || 1000), r = +q('#nRisk').value || 0, h = +q('#nHalf').value, pk = +q('#nPeak').value || 71, pt = Math.min(50, Math.max(5, +q('#nPit').value || 25));
    let l = `${s} BUY ${n} PIT${tf}<${pt} PEAK${tf}>${pk} SL=LOW`;
    if (h > 0) l += ` HALF=R${h}`;
    if (OPT.EOD) l += ' EOD'; if (OPT.RTH) l += ' RTH';
    if (r > 0) l += ` RISK=${r}`; if (OPT.REPEAT) l += ' REPEAT';
    return l;
  }
  function opts() {
    q('#nOpts').innerHTML = [['RTH', '정규장만'], ['EOD', '장 마감 정리'], ['REPEAT', '매일 반복']].map(([k, t]) => `<button class="${OPT[k] ? 'on' : ''}" data-k="${k}">${t}</button>`).join('');
    q('#nOpts').querySelectorAll('button').forEach(b => b.onclick = () => { OPT[b.dataset.k] = !OPT[b.dataset.k]; opts(); });
    q('#nPrev').textContent = build();
  }
  function xLv(v, sign) {
    v = String(v || '').trim().replace(/\s/g, '').replace('−', '-'); if (!v) return '';
    if (v.endsWith('%')) { const n = Math.abs(parseFloat(v)); if (!(n > 0)) return ''; return (sign < 0 ? '-' : '+') + n + '%'; }
    const n = parseFloat(v); return n > 0 ? String(n) : '';
  }
  function sBuild() {
    const s = q('#sSym').value, n = Math.max(1, Math.trunc(+q('#sQty').value || 1));
    const tp = xLv(q('#sTp').value, 1), sl = xLv(q('#sSl').value, -1);
    if (!tp && !sl && !SOPT.EOD) return '';
    let l = `${s} SELL ${n}`;
    if (tp) l += ' TP=' + tp; if (sl) l += ' SL=' + sl; if (SOPT.EOD) l += ' EOD';
    return l;
  }
  function sOpts() {
    q('#sOpts').innerHTML = [['EOD', '장 마감 정리']].map(([k, t]) => `<button class="${SOPT[k] ? 'on' : ''}" data-k="${k}">${t}</button>`).join('');
    q('#sOpts').querySelectorAll('button').forEach(b => b.onclick = () => { SOPT[b.dataset.k] = !SOPT[b.dataset.k]; sOpts(); });
    q('#sPrev').textContent = sBuild() || '익절이나 손절을 넣어주세요';
  }
  async function refresh() {
    if (BUSY) return;
    try {
      const r = await fetch('/api/dash', { headers: { 'x-pin': getPin() }, cache: 'no-store' }); const j = await r.json(); if (!r.ok) return;
      if (BUSY) return;
      const mn = j.manual || {}; R = (mn.raw && mn.raw.rules) || {}; LINES = (mn.lines || []).slice(); list();
    } catch { /* 다음에 */ }
  }
  function mount(box, manual) {
    root = box; root.classList.add('pt');
    const sel = (id, o) => `<select id="${id}">${o}</select>`, inp = (id, v, t, m) => `<input id="${id}" type="${t || 'number'}" inputmode="${m || 'numeric'}" value="${v}">`;
    root.innerHTML = `<div class="lines"></div>
<div class="nb"><div class="h">새 웅덩이 줄 추가</div><div class="g">
<div><label>종목</label>${sel('nSym', '<option>SOXL</option><option>SOXS</option>')}</div>
<div><label>봉</label>${sel('nTf', '<option value="3M">3분봉</option><option value="1M">1분봉</option><option value="5M">5분봉</option>')}</div>
<div><label>최대 수량</label>${inp('nQty', 1000)}</div>
<div><label>RISK ($)</label>${inp('nRisk', 700)}</div>
<div><label>절반 익절 (R)</label><input id="nHalf" type="number" inputmode="decimal" step="0.1" value="0.5"></div>
<div><label>웅덩이 RSI (이 아래)</label>${inp('nPit', 25)}</div>
<div><label>봉우리 RSI (이 위)</label>${inp('nPeak', 71)}</div>
</div><div class="ob" id="nOpts"></div><div class="pv" id="nPrev"></div><button class="btn" id="nAdd">＋ 이 줄 추가 (바로 저장)</button></div>
<div class="nb"><div class="h">갖고 있는 주식 매도 줄 (익절·손절) · 스나이퍼 물량 말고 따로 산 것만 · %는 평균단가 기준</div><div class="g">
<div><label>종목</label>${sel('sSym', '<option>SOXL</option><option>SOXS</option>')}</div>
<div><label>수량</label>${inp('sQty', 500)}</div>
<div><label>익절 (가격 또는 +%)</label><input id="sTp" type="text" placeholder="예: 36 또는 +5%"></div>
<div><label>손절 (가격 또는 −%)</label><input id="sSl" type="text" placeholder="예: 30 또는 -3%"></div>
</div><div class="ob" id="sOpts"></div><div class="pv" id="sPrev"></div><button class="btn" id="sAdd">＋ 매도 줄 추가 (바로 저장)</button></div>
<div class="msg"></div>`;
    ['#nSym', '#nTf', '#nQty', '#nRisk', '#nHalf', '#nPit', '#nPeak'].forEach(s => q(s).addEventListener('input', () => q('#nPrev').textContent = build()));
    ['#sSym', '#sQty', '#sTp', '#sSl'].forEach(s => q(s).addEventListener('input', sOpts));
    q('#nAdd').onclick = () => { const l = build(); if (LINES.includes(l)) { msg('같은 줄이 이미 있어요', 1); return; } LINES.push(l); save('추가함'); };
    q('#sAdd').onclick = () => { const l = sBuild(); if (!l) { msg('익절이나 손절을 넣어주세요', 1); return; } if (LINES.includes(l)) { msg('같은 줄이 이미 있어요', 1); return; } LINES.push(l); save('매도 줄 추가함'); };
    opts(); sOpts();
    const mn = manual || {}; R = (mn.raw && mn.raw.rules) || {}; LINES = (mn.lines || []).slice(); list();
    clearInterval(window.__ptT); window.__ptT = setInterval(() => { if (!document.hidden) refresh(); }, 20000);
  }
  window.PT = { mount, refresh };
})();
