// api/_meritz.js — 메리츠 Open API 최소 클라이언트 (해외주식) · 밑줄 파일은 라우트가 아님
// 환경변수: MERITZ_APP_KEY, MERITZ_APP_SECRET, (선택) MERITZ_MAC (12자리 16진수)
const BASE = 'https://openapi.imeritz.com:9443';
const TOKEN_DEAD = new Set(['EGW00121', 'EGW00123']);
const OK = new Set(['0000', '0001', '5762', '5766', '5820', '5822']);
export const EXCH = { // 시세 거래소 코드 → 주문 벤더 코드
  AX: '0066', OQ: '0537', NY: '0321',
};
export const SYMBOL_EXCH = { SOXL: 'AX', SOXS: 'AX', TQQQ: 'OQ', SQQQ: 'OQ', NVDL: 'OQ', UCO: 'AX', SCO: 'AX', TSLL: 'OQ' };

const mac = () => (process.env.MERITZ_MAC || '02A1B2C3D4E5').replace(/[^0-9A-Fa-f]/g, '').slice(0, 12).toUpperCase();

async function http(method, path, { token, query, body, form, timeout = 9000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let url = BASE + path;
  if (query) url += '?' + new URLSearchParams(query).toString();
  const headers = {};
  if (token) { headers.authorization = `Bearer ${token}`; headers.mac_address = mac(); }
  let payload;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body) { headers['content-type'] = 'application/json; charset=utf-8'; payload = JSON.stringify(body); }
  try {
    const r = await fetch(url, { method, headers, body: payload, signal: ctl.signal });
    let j; const txt = await r.text();
    try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 300) }; }
    return { status: r.status, body: j };
  } finally { clearTimeout(t); }
}

export async function issueToken() {
  const key = process.env.MERITZ_APP_KEY, sec = process.env.MERITZ_APP_SECRET;
  if (!key || !sec) throw new Error('MERITZ_APP_KEY/SECRET 없음');
  const r = await http('POST', '/oauth2/token', {
    form: { grant_type: 'client_credentials', client_id: key.trim(), client_secret: sec.trim(), scope: 'login' },
  });
  if (r.status !== 200 || !r.body.access_token) throw new Error(`토큰 발급 실패 ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in || 43200) - 3600) * 1000 };
}

// 호출 → data. 실패면 throw (code 포함)
export async function call(tok, method, path, opt = {}) {
  const r = await http(method, path, { ...opt, token: tok.token });
  const code = r.body && r.body.rsp_cd;
  if (TOKEN_DEAD.has(code)) { const e = new Error('TOKEN_DEAD'); e.code = 'TOKEN_DEAD'; throw e; }
  if (r.status !== 200 || (code && !OK.has(code))) {
    const e = new Error(`${path} ${r.status} ${code || ''} ${r.body.rsp_msg || ''} ${r.body.rsp_sub_msg || ''}`.trim());
    e.code = code || `HTTP${r.status}`; throw e;
  }
  return r.body.data;
}

// 세션별 현재가. 기본 현재가(/prices)는 주간거래 체결을 안 담아 주간에는 전일 정규장 종가가 나온다
//   day   → /prices/daytime (dytm_prpr). 없으면 에러(멈춤) — 옛 가격으로 판단하지 않는다
//   after → /prices/after (mkt_aft_prpr). 애프터 체결이 아직 없으면 정규장 현재가
export async function price(tok, sym, session) {
  const ex = SYMBOL_EXCH[sym] || 'AX';
  const query = { mrkt_div_code: 'OV', mrkt_cls_code: ex, iscd: sym, dely_rltm_cls_code: process.env.MERITZ_REALTIME || '0' };
  if (session === 'day') {
    const d = await call(tok, 'GET', '/market/v1/overseas/prices/daytime', { query });
    const p = Number(d && d.dytm_prpr);
    const on = d && d.dytm_mkt_yn;
    if (!(p > 0) || (on != null && on !== '' && !['1', 'Y'].includes(String(on)))) throw new Error(`주간 시세 없음 ${sym} (${p}, ${on})`);
    return p;
  }
  if (session === 'after') {
    try {
      const d = await call(tok, 'GET', '/market/v1/overseas/prices/after', { query });
      const p = Number(d && d.mkt_aft_prpr);
      if (p > 0) return p;
    } catch (e) { if (e.code === 'TOKEN_DEAD') throw e; }
  }
  const d = await call(tok, 'GET', '/market/v1/overseas/prices', { query });
  const p = Number(d && d.prpr);
  if (!(p > 0)) throw new Error(`현재가 없음 ${sym}`);
  return p;
}

export async function order(tok, side, sym, qty, kind, px) {
  // kind: LIMIT | MOC
  const ex = EXCH[SYMBOL_EXCH[sym] || 'AX'];
  const cls = kind === 'MOC' ? '34' : '01';
  const body = {
    ovrs_stck_symb_iscd: sym, ovrs_exch_vndr_idno: ex, oder_cls_code: cls,
    oder_cond_cls_code: kind === 'MOC' ? '7' : '0', odqt: qty,
    ovrs_stck_oder_prc: kind === 'MOC' ? 0 : Number(px.toFixed(2)),
  };
  const path = side === 'BUY' ? '/trading/v1/overseas/orders/buy' : '/trading/v1/overseas/orders/sell';
  let d = await call(tok, 'POST', path, { body });
  // 경고(1)·PTP 과세 확인(3)은 확인값으로 재전송해야 접수된다. 문서에 Y/A 가 섞여 있어 둘 다 시도
  for (const yn of ['Y', 'A']) {
    if (!(d && (d.warn_cls_code === '1' || d.warn_cls_code === '3'))) break;
    d = await call(tok, 'POST', path, { body: { ...body, warn_cnfr_yn: yn } });
  }
  if (!d || !d.oder_no || (d.warn_cls_code && d.warn_cls_code !== '0')) {
    const e = new Error(`주문 미접수 warn=${d && d.warn_cls_code} ${d && d.warn_msg || ''}`.trim()); e.code = 'NOT_ACCEPTED'; throw e;
  }
  return { no: d.oder_no, cls };
}

export async function cancel(tok, ord, qty) {
  return call(tok, 'POST', '/trading/v1/overseas/orders/cancel', {
    body: { oder_date: ord.date, orgl_oder_no: ord.no, oder_cls_code: ord.cls, odqt: qty },
  });
}

export async function ordersToday(tok) {
  const d = await call(tok, 'GET', '/trading/v1/overseas/orders/today', { query: { cntg_cls_code: '0', seln_byov_clcd: '0' } });
  return Array.isArray(d) ? d : [];
}

export async function cashUSD(tok) {
  const d = await call(tok, 'GET', '/accounts/v1/me/overseas/currencies');
  const row = (Array.isArray(d) ? d : []).find(x => x.crcd === 'USD');
  return row ? Number(row.estm_frcr_amt) : 0;
}

export async function holdings(tok) {
  const d = await call(tok, 'GET', '/accounts/v1/me/overseas/holdings');
  const out = {};
  for (const x of (Array.isArray(d) ? d : [])) {
    const s = x.ovrs_stck_symb_iscd || String(x.iscd || '').split('.')[0];
    out[s] = { qty: Number(x.rmnd_dqty || 0), sellable: Number(x.seln_able_dqty || 0), avg: Number(x.avrg_unpr || 0) };
  }
  return out;
}

// 분봉: 완성된 봉만, 오래된 것 → 최신 {id, o, h, l, c}. 첫 행(진행 중인 봉)은 버린다
export async function candles(tok, sym, sec) {
  // 3분봉: 메리츠가 3분 단위를 주지 않을 수 있어 1분봉을 3개씩 묶어 만든다 (정각 기준 :00 :03 :06 …)
  if (Number(sec) === 180) {
    const one = await candles(tok, sym, 60);
    const out = [];
    for (const b of one) {
      const hh = Number(b.id.slice(8, 10)), mm = Number(b.id.slice(10, 12));
      const key = `${b.id.slice(0, 8)}${String(hh).padStart(2, '0')}${String(mm - (mm % 3)).padStart(2, '0')}00`;
      const last = out[out.length - 1];
      if (last && last.id === key) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.n++; }
      else out.push({ id: key, o: b.o, h: b.h, l: b.l, c: b.c, n: 1 });
    }
    if (out.length && out[out.length - 1].n < 3) out.pop(); // 아직 안 끝난 3분봉은 버린다
    return out;
  }
  const ex = SYMBOL_EXCH[sym] || 'AX';
  const d = await call(tok, 'GET', '/market/v1/overseas/candles/minutes', {
    query: { mrkt_div_code: 'OV', mrkt_cls_code: ex, iscd: sym, dely_rltm_cls_code: process.env.MERITZ_REALTIME || '0', hour_cls_code: String(sec) },
  });
  const rows = Array.isArray(d) ? d : [];
  return rows.slice(1).reverse().map(x => ({
    id: `${x.korea_date}${x.korea_hour}`, o: Number(x.oprc), h: Number(x.hprc), l: Number(x.lprc), c: Number(x.prpr),
  })).filter(b => b.c > 0);
}

// 일봉: 최신 → 오래된 {date:'YYYY-MM-DD', c}
export async function days(tok, sym) {
  const ex = SYMBOL_EXCH[sym] || 'AX';
  const d = await call(tok, 'GET', '/market/v1/overseas/candles/days', {
    query: { mrkt_div_code: 'OV', mrkt_cls_code: ex, iscd: sym, dely_rltm_cls_code: process.env.MERITZ_REALTIME || '0', mod_stpr_cls_code: '1' },
  });
  return (Array.isArray(d) ? d : []).map(x => ({ date: `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`, c: Number(x.prpr) })).filter(x => x.c > 0);
}
