#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MNQ 방어모드 자동매매
  매수: min(전일종가, 그제종가) × (1 − BUY_PCT/100), 틱 내림
  매도: 각 티어 진입가 × (1 + SELL_PCT/100), 틱 올림
  청산: HOLD_DAYS 경과 시 MOC (시장가)
  규칙: MOC가 있는 날엔 다른 매도 주문을 넣지 않음

모드
  PAPER : 시세 조회 + 신호 계산 + 상태 저장 (주문 없음)  ← 기본
  LIVE  : 한투 API로 실제 주문 (해외선물은 모의투자 미지원 → 실계좌만)

실행
  python mnq_bot.py              # PAPER
  MODE=LIVE python mnq_bot.py    # LIVE
"""
import os, json, math, sys, time
from datetime import datetime, timedelta, timezone
import urllib.request, urllib.parse

# ─────────── 설정 ───────────
MODE       = os.getenv("MODE", "PAPER").upper()
QTY        = int(os.getenv("QTY", "1"))        # 티어당 계약수
TIERS      = int(os.getenv("TIERS", "3"))      # 최대 티어
HOLD_DAYS  = int(os.getenv("HOLD_DAYS", "3"))  # 보유일(거래일)
ROLL_STOP_DAYS = int(os.getenv("ROLL_STOP_DAYS", "7"))  # 만기 N일 전부터 신규 중단
BUY_PCT    = float(os.getenv("BUY_PCT", "0.5"))
SELL_PCT   = float(os.getenv("SELL_PCT", "0.5"))
TICK       = 0.25
MULT       = 2                                  # MNQ 승수 $2
MARGIN_USD = float(os.getenv("MARGIN_USD", "4374"))

STATE_FILE = os.getenv("STATE_FILE", "mnq_state.json")
TG_TOKEN   = os.getenv("TG_TOKEN", "")
TG_CHAT    = os.getenv("TG_CHAT", "")

# 한투 API (LIVE 전용)
KIS_KEY    = os.getenv("KIS_APP_KEY", "")
KIS_SECRET = os.getenv("KIS_APP_SECRET", "")
KIS_ACCT   = os.getenv("KIS_ACCOUNT_NO", "")   # 8자리
KIS_PROD   = os.getenv("KIS_ACCOUNT_CODE", "08")
KIS_BASE   = "https://openapi.koreainvestment.com:9443"
SYMBOL     = os.getenv("SYMBOL", "MNQ")        # 종목 루트

# ─────────── 유틸 ───────────
flr = lambda v: math.floor(v / TICK) * TICK
cel = lambda v: math.ceil (v / TICK) * TICK

def log(*a):
    ts = datetime.now(timezone(timedelta(hours=9))).strftime("%m-%d %H:%M")
    print(f"[{ts}]", *a, flush=True)

def notify(msg):
    log(msg.replace("\n", " | "))
    if TG_TOKEN and TG_CHAT:
        try:
            url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
            data = urllib.parse.urlencode({
                "chat_id": TG_CHAT, "text": msg, "parse_mode": "HTML"
            }).encode()
            urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=10)
        except Exception as e:
            log("텔레그램 실패:", e)

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {"positions": [], "history": [], "realized": 0.0}

def save_state(s):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)

# ─────────── 시세 ───────────
HUNTER_API = (os.getenv("HUNTER_API") or "https://hunter-v10.vercel.app").rstrip("/")

def _get_json(url, timeout=15):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

def fetch_hunter(symbol="NQ=F", days=40):
    """헌터 앱 /api/history 사용 (권장)"""
    et = timezone(timedelta(hours=-5))
    end = (datetime.now(et) + timedelta(days=1)).strftime("%Y-%m-%d")
    start = (datetime.now(et) - timedelta(days=days)).strftime("%Y-%m-%d")
    url = (f"{HUNTER_API}/api/history?symbol={urllib.parse.quote(symbol)}"
           f"&start={start}&end={end}&_={int(time.time())}")
    d = _get_json(url)
    if d.get("error") or not d.get("bars"):
        raise RuntimeError(d.get("error", "no bars"))
    return [(b["date"], float(b["close"])) for b in d["bars"] if b.get("close")]

def fetch_yahoo(symbol="NQ=F", days=40):
    """야후 직접 (폴백)"""
    end = int(time.time()); start = end - days*86400
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?period1={start}&period2={end}&interval=1d")
    d = _get_json(url)
    res = d["chart"]["result"][0]
    out = []
    for t, c in zip(res["timestamp"], res["indicators"]["quote"][0]["close"]):
        if c is None: continue
        dt = datetime.fromtimestamp(t, timezone(timedelta(hours=-5)))
        out.append((dt.strftime("%Y-%m-%d"), float(c)))
    return out

def fetch_stooq(symbol="qqq.us", days=40):
    """Stooq CSV (야후 차단 시 폴백). NQ 선물은 없어 QQQ/^NDX만"""
    url = f"https://stooq.com/q/d/l/?s={symbol}&i=d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        txt = r.read().decode()
    out = []
    for line in txt.strip().split("\n")[1:]:
        c = line.split(",")
        if len(c) >= 5:
            try: out.append((c[0], float(c[4])))
            except ValueError: pass
    return out[-days:]

def drop_intraday(bars):
    """미국 정규장 마감(16:00 ET) 전이면 당일 봉 제외"""
    if len(bars) < 2: return bars
    et = datetime.now(timezone(timedelta(hours=-5)))
    if bars[-1][0] == et.strftime("%Y-%m-%d") and et.hour < 16:
        return bars[:-1]
    return bars

def get_prices():
    """(당일종가, 전일종가, 그제종가, 날짜, 소스)"""
    errs = []
    # 1) 헌터 앱 (선물 직접)
    for sym in ("NQ=F", "^NDX"):
        try:
            b = drop_intraday(fetch_hunter(sym))
            if len(b) >= 3 and b[-1][1] > 5000:
                return b[-1][1], b[-2][1], b[-3][1], b[-1][0], f"{sym}/hunter"
        except Exception as e:
            errs.append(f"hunter {sym}: {e}")

    # 2) 야후 (429 대비 재시도)
    for sym in ("NQ=F", "^NDX"):
        for attempt in range(3):
            try:
                b = drop_intraday(fetch_yahoo(sym))
                if len(b) >= 3 and b[-1][1] > 5000:
                    return b[-1][1], b[-2][1], b[-3][1], b[-1][0], f"{sym}/yahoo"
            except Exception as e:
                errs.append(f"yahoo {sym} #{attempt+1}: {e}")
                time.sleep(3 * (attempt + 1))

    # 3) Stooq (^NDX 지수)
    sc_ndx = float(os.getenv("NDX_SCALE", "1.0"))
    try:
        b = drop_intraday(fetch_stooq("^ndx"))
        if len(b) >= 3 and b[-1][1] > 5000:
            return (b[-1][1]*sc_ndx, b[-2][1]*sc_ndx, b[-3][1]*sc_ndx,
                    b[-1][0], "^NDX/stooq")
    except Exception as e:
        errs.append(f"stooq ^ndx: {e}")

    # 4) QQQ × 배율
    sc = float(os.getenv("QQQ_SCALE", "41.4"))
    for fn, tag in ((fetch_hunter, "hunter"), (fetch_stooq, "stooq"), (fetch_yahoo, "yahoo")):
        try:
            b = drop_intraday(fn("qqq.us" if tag == "stooq" else "QQQ"))
            if len(b) >= 3:
                return b[-1][1]*sc, b[-2][1]*sc, b[-3][1]*sc, b[-1][0], f"QQQ×{sc}/{tag}"
        except Exception as e:
            errs.append(f"{tag} QQQ: {e}")

    for e in errs: log("  ", e)
    raise RuntimeError(f"모든 시세 소스 실패 ({len(errs)}건)")

# ─────────── 한투 API (LIVE) ───────────
_token = {"v": None, "exp": 0}

def kis_token():
    if _token["v"] and time.time() < _token["exp"]:
        return _token["v"]
    body = json.dumps({"grant_type": "client_credentials",
                       "appkey": KIS_KEY, "appsecret": KIS_SECRET}).encode()
    req = urllib.request.Request(KIS_BASE + "/oauth2/tokenP", data=body,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.load(r)
    _token["v"] = d["access_token"]
    _token["exp"] = time.time() + 60*60*20      # 24h 유효, 20h로 보수적
    return _token["v"]

def _kis_post(path, tr_id, body):
    req = urllib.request.Request(KIS_BASE + path, data=json.dumps(body).encode(), headers={
        "content-type": "application/json; charset=utf-8",
        "authorization": f"Bearer {kis_token()}",
        "appkey": KIS_KEY, "appsecret": KIS_SECRET, "tr_id": tr_id,
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def _kis_get(path, tr_id, params):
    url = KIS_BASE + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "content-type": "application/json; charset=utf-8",
        "authorization": f"Bearer {kis_token()}",
        "appkey": KIS_KEY, "appsecret": KIS_SECRET, "tr_id": tr_id,
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def kis_order(side, qty, symbol_full, price=None):
    """해외선물 주문  tr_id=OTFM3001U
       side  : 'BUY'(02) | 'SELL'(01)
       price : None이면 시장가(가격구분 2, 체결조건 2)
               값이 있으면 지정가(가격구분 1, 체결조건 6=EOD)"""
    is_mkt = price is None
    body = {
        "CANO": KIS_ACCT,
        "ACNT_PRDT_CD": KIS_PROD,
        "OVRS_FUTR_FX_PDNO": symbol_full,
        "SLL_BUY_DVSN_CD": "02" if side == "BUY" else "01",
        "FM_LQD_USTL_CCLD_DT": "",
        "FM_LQD_USTL_CCNO": "",
        "PRIC_DVSN_CD": "2" if is_mkt else "1",      # 1지정 2시장
        "FM_LIMIT_ORD_PRIC": "" if is_mkt else f"{price:.2f}",
        "FM_STOP_ORD_PRIC": "",
        "FM_ORD_QTY": str(qty),
        "FM_LQD_LMT_ORD_PRIC": "",
        "FM_LQD_STOP_ORD_PRIC": "",
        "CCLD_CNDT_CD": "2" if is_mkt else "6",      # 2시장가 6EOD지정가
        "CPLX_ORD_DVSN_CD": "0",
        "ECIS_RSVN_ORD_YN": "N",
        "FM_HDGE_ORD_SCRN_YN": "N",
    }
    return _kis_post("/uapi/overseas-futureoption/v1/trading/order", "OTFM3001U", body)

def kis_positions():
    """미결제 내역 조회  tr_id=OTFM1412R"""
    return _kis_get("/uapi/overseas-futureoption/v1/trading/inquire-unpd", "OTFM1412R", {
        "CANO": KIS_ACCT, "ACNT_PRDT_CD": KIS_PROD,
        "CTX_AREA_FK200": "", "CTX_AREA_NK200": "",
    })

def kis_deposit():
    """예수금 조회  tr_id=OTFM1411R"""
    return _kis_get("/uapi/overseas-futureoption/v1/trading/inquire-deposit", "OTFM1411R", {
        "CANO": KIS_ACCT, "ACNT_PRDT_CD": KIS_PROD,
        "CRCY_CD": "USD", "INQR_DT": datetime.now().strftime("%Y%m%d"),
    })

def third_friday(y, m):
    cnt = 0
    for d in range(1, 32):
        try: dt = datetime(y, m, d)
        except ValueError: break
        if dt.weekday() == 4:
            cnt += 1
            if cnt == 3: return dt
    return None

def days_to_expiry():
    """현재 월물 만기까지 남은 달력일"""
    now = datetime.now(timezone(timedelta(hours=-5))).replace(tzinfo=None)
    for y in (now.year, now.year+1):
        for q in (3, 6, 9, 12):
            exp = third_friday(y, q)
            if exp and exp >= now:
                return (exp - now).days, exp
    return 99, None

def active_contract():
    """활성 월물 코드 (만기 14일 전 롤오버). 예: MNQZ26"""
    M = {3: "H", 6: "M", 9: "U", 12: "Z"}
    now = datetime.now(timezone(timedelta(hours=-5))).replace(tzinfo=None)
    y = now.year
    for _ in range(8):
        for q in (3, 6, 9, 12):
            exp = third_friday(y, q)
            if exp and (exp - now).days > 14:
                return f"{SYMBOL}{M[q]}{str(y)[2:]}"
        y += 1
    return f"{SYMBOL}Z{str(now.year)[2:]}"

# ─────────── 거래일 계산 ───────────
def biz_days(d1, d2):
    a, b, n = datetime.strptime(d1, "%Y-%m-%d"), datetime.strptime(d2, "%Y-%m-%d"), 0
    while a < b:
        a += timedelta(days=1)
        if a.weekday() < 5: n += 1
    return n

# ─────────── 메인 ───────────
def main():
    st = load_state()
    pos = sorted(st["positions"], key=lambda x: x["date"])
    px, p1, p2, today, src = get_prices()

    buy_thr  = flr(min(p1, p2) * (1 - BUY_PCT/100))    # 전일·그제 (당일 제외)
    contract = active_contract()

    lines = [f"<b>🎯 MNQ {MODE}</b>",
             f"{src} · {today} 종가 <b>{px:,.2f}</b>",
             f"월물 {contract} · 보유 {len(pos)}/{TIERS}티어", ""]
    _d2e, _exp = days_to_expiry()
    if _exp: lines[2] += f" · 만기 D-{_d2e}"

    # ── 조건 판정 (종가 기준) → 충족분만 시장가 주문 ──
    moc = [x for x in pos if biz_days(x["date"], today) >= HOLD_DAYS]
    orders = []

    if moc:
        # MOC 있는 날: MOC만 청산 (다른 매도 없음)
        for x in moc:
            orders.append(("MOC", x["qty"],
                           f"{x['date']} 진입 {x['entry']:,.2f} · {biz_days(x['date'],today)}일 경과"))
    else:
        # 익절 조건 충족한 티어만
        for i, x in enumerate(pos):
            sp = cel(x["entry"] * (1 + SELL_PCT/100))
            if px >= sp:
                orders.append(("SELL", x["qty"],
                               f"T{i+1} 진입 {x['entry']:,.2f} → 기준 {sp:,.2f} 충족"))

    # 매수 조건 (만기 임박 시 신규 중단)
    d2e, exp_dt = days_to_expiry()
    roll_block = d2e <= ROLL_STOP_DAYS
    if len(pos) < TIERS and px <= buy_thr and not roll_block:
        orders.append(("BUY", QTY,
                       f"T{len(pos)+1} · 종가 {px:,.2f} ≤ 기준 {buy_thr:,.2f} (전일 {p1:,.0f}·그제 {p2:,.0f})"))
    elif roll_block and len(pos) < TIERS and px <= buy_thr:
        lines.append(f"⚠️ <b>만기 D-{d2e} — 신규 매수 중단</b> (조건은 충족했음)")

    # 만기 임박 경고
    if d2e <= ROLL_STOP_DAYS and pos:
        lines.append(f"🔴 <b>만기 D-{d2e} — 보유 {len(pos)}티어 정리 필요</b>")

    # 출력
    lines.append(f"기준가 · 매수 <code>{buy_thr:,.2f}</code> 이하")
    if pos and not moc:
        for i, x in enumerate(pos):
            lines.append(f"      T{i+1} 매도 <code>{cel(x['entry']*(1+SELL_PCT/100)):,.2f}</code> 이상")
    lines.append("")

    if orders:
        lines.append("<b>🔔 시장가 주문</b>")
        for typ, q, memo in orders:
            tag = {"BUY":"🟢 매수","SELL":"🟣 매도","MOC":"🟡 MOC"}[typ]
            lines.append(f"{tag} × {q}계약")
            lines.append(f"    <i>{memo}</i>")
    else:
        lines.append("✋ <b>조건 미충족 — 주문 없음</b>")

    # 평가손익
    if pos:
        un = sum((px - x["entry"]) * MULT * x["qty"] for x in pos)
        held = sum(x["qty"] for x in pos)
        lines += ["", f"보유 {held}계약 · 평가 <b>${un:,.0f}</b>",
                  f"증거금 ${held*MARGIN_USD:,.0f}"]

    notify("\n".join(lines))

    # ③ 실행
    if MODE == "LIVE":
        if not (KIS_KEY and KIS_SECRET and KIS_ACCT):
            notify("⚠️ LIVE인데 API 키가 없음 — 주문 생략")
            return
        results = []
        for typ, q, memo in orders:
            try:
                side = "BUY" if typ == "BUY" else "SELL"
                r = kis_order(side, q, contract, None)   # 전부 시장가
                ok = r.get("rt_cd") == "0"
                results.append(f"{'✅' if ok else '❌'} {typ} {q}계약 · {r.get('msg1','')[:40]}")
                log(f"{typ} {q}계약 →", r.get("rt_cd"), r.get("msg1"))
                if ok and typ == "BUY":
                    pos.append({"entry": px, "date": today, "qty": q})
                elif ok and typ in ("SELL", "MOC"):
                    pass   # 체결 확인 후 다음 실행 때 잔고로 동기화
            except Exception as e:
                results.append(f"❌ {typ} 실패: {e}")
                log(f"주문 실패 {typ}:", e)
        if results:
            notify("<b>주문 결과</b>\n" + "\n".join(results))
        # 잔고로 포지션 동기화
        try:
            bal = kis_positions()
            if bal.get("rt_cd") == "0":
                rows = bal.get("output1", []) or []
                held = sum(int(float(x.get("ustl_qty", 0) or 0)) for x in rows
                           if SYMBOL in str(x.get("ovrs_futr_fx_pdno", "")))
                log(f"잔고 확인: {held}계약")
        except Exception as e:
            log("잔고 조회 실패:", e)
        st["positions"] = pos
        save_state(st)
    else:
        # PAPER: 조건 충족분을 종가에 체결한 것으로 기록
        for typ, q, memo in orders:
            if typ in ("MOC", "SELL"):
                x = moc.pop(0) if typ == "MOC" else next(
                    (y for y in pos if px >= cel(y["entry"]*(1+SELL_PCT/100))), None)
                if x and x in pos:
                    pnl = (px - x["entry"]) * MULT * x["qty"]
                    st["realized"] += pnl
                    st["history"].append({**x, "exit": px, "exit_date": today,
                                          "pnl": pnl, "reason": typ})
                    pos.remove(x)
            elif typ == "BUY":
                pos.append({"entry": px, "date": today, "qty": q})
        st["positions"] = pos
        save_state(st)
        log(f"누적 실현 ${st['realized']:,.0f} · 거래 {len(st['history'])}건")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        notify(f"❌ 봇 오류: {e}")
        raise
