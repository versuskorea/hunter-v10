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
import urllib.request, urllib.parse, urllib.error

# ─────────── 설정 ───────────
def _flag(name, default="0"):
    """환경변수를 유연하게 불리언으로 — 공백/대소문자/true 허용"""
    v = (os.getenv(name) or default).strip().lower()
    return v in ("1", "true", "yes", "y", "on")

MODE       = os.getenv("MODE", "PAPER").strip().upper()
QTY        = int(os.getenv("QTY", "1"))        # 티어당 계약수
TIERS      = int(os.getenv("TIERS", "3"))      # 최대 티어
HOLD_DAYS  = int(os.getenv("HOLD_DAYS", "3"))  # 보유일(거래일)
ROLL_STOP_DAYS = int(os.getenv("ROLL_STOP_DAYS", "14"))  # 만기 N일 전에 다음 월물로 전환
BUY_PCT    = float(os.getenv("BUY_PCT", "0.5"))
SELL_PCT   = float(os.getenv("SELL_PCT", "0.5"))
TICK       = 0.25
MULT       = 2                                  # MNQ 승수 $2
MARGIN_USD = float(os.getenv("MARGIN_USD", "4721"))   # 개시증거금 (달러)
FX         = float(os.getenv("FX", "1390"))           # 환율
# ── 자본 / 복리 ──
TOTAL_PAID = float(os.getenv("TOTAL_PAID", "3000")) * 1e4   # 총 납입액 (만원) — 입금하면 갱신
INITIAL_CAP = float(os.getenv("INITIAL_CAP", "3000")) * 1e4 # 최초 자본 (복리 기준선, 고정)
PER_CONTRACT = float(os.getenv("PER_CONTRACT", "2000")) * 1e4  # 수익 N만마다 총계약 +1
BUFFER     = float(os.getenv("BUFFER", "30")) / 100   # 여유 버퍼
LAD_ORDER  = os.getenv("LAD_ORDER", "mid")            # mid / back / front
# ── 공격모드 (T1만) ──
ATK_ON     = _flag("ATK_ON", "0")
ATK_MA     = int(os.getenv("ATK_MA", "20"))
ATK_BUY    = float(os.getenv("ATK_BUY", "0.5"))
ATK_SELL   = float(os.getenv("ATK_SELL", "1.0"))

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
    return {"positions": [], "history": [], "realized": 0.0, "equity": TOTAL_PAID, "step": 0}

def save_state(s):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)

# ─────────── 시세 ───────────
HUNTER_API = (os.getenv("HUNTER_API") or "https://hunter-v10.vercel.app").rstrip("/")
CLOSE_1600 = _flag("CLOSE_1600", "1")   # 16:00 ET(한국 5시) 종가 사용
DATA_SYMBOL = os.getenv("DATA_SYMBOL", "^NDX")     # 폴백 데이터 (만기 없는 지수)
USE_CONTRACT_SYM = _flag("USE_CONTRACT_SYM", "1")   # 거래 월물과 같은 심볼 우선
USE_KIS_QUOTE = _flag("USE_KIS_QUOTE", "1")         # 한투 시세 우선 사용
# ── 운용 스위치 ──
PAUSE_BUY = _flag("PAUSE_BUY", "0")   # 신규 매수만 중단 (보유분은 정상 청산)
PAUSE_ALL = _flag("PAUSE_ALL", "0")   # 전체 중단 (알림만)
CLOSE_ALL = _flag("CLOSE_ALL", "0")   # 보유분 전량 청산
FORCE_RUN = _flag("FORCE_RUN", "0")   # 장 마감 전/중복이어도 강제 실행 (테스트용)
WAIT_CLOSE = _flag("WAIT_CLOSE", "1")           # 16:00 ET 마감까지 대기 후 즉시 판정
WAIT_MAX_SEC = int(float(os.getenv("WAIT_MAX_SEC", "420")))   # 최대 대기(초)
ORDER_DEADLINE = int(float(os.getenv("ORDER_DEADLINE", "5")))  # 16:00 이후 N분 넘으면 주문 취소
MIN_GAP    = os.getenv("MIN_GAP", "1").strip() or "1"        # 한투 분봉 간격(분)

def us_dst(d=None):
    """미국 서머타임 여부 — 3월 둘째 일요일 ~ 11월 첫째 일요일"""
    d = d or datetime.utcnow()
    y = d.year
    # 3월 둘째 일요일 02:00 ET (= 07:00 UTC)
    mar = datetime(y, 3, 1)
    sundays = [i for i in range(1, 15) if datetime(y, 3, i).weekday() == 6]
    start = datetime(y, 3, sundays[1], 7)
    # 11월 첫째 일요일 02:00 ET (= 06:00 UTC)
    nsun = [i for i in range(1, 8) if datetime(y, 11, i).weekday() == 6]
    end = datetime(y, 11, nsun[0], 6)
    return start <= d < end

def et_now():
    """현재 미국 동부 시각 (서머타임 자동 반영)"""
    off = -4 if us_dst() else -5
    return datetime.now(timezone(timedelta(hours=off)))

def et_tz():
    return timezone(timedelta(hours=-4 if us_dst() else -5))

def _get_json(url, timeout=15):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", "replace")[:200]
        except Exception: pass
        raise RuntimeError(f"HTTP {e.code} · {url[:90]} · {body}") from None

def fetch_hunter(symbol="NQ=F", days=40):
    """헌터 앱 /api/history 사용 (권장)"""
    end = (et_now() + timedelta(days=1)).strftime("%Y-%m-%d")
    start = (et_now() - timedelta(days=days)).strftime("%Y-%m-%d")
    url = (f"{HUNTER_API}/api/history?symbol={urllib.parse.quote(symbol)}"
           f"&start={start}&end={end}&_={int(time.time())}")
    d = _get_json(url)
    if d.get("error") or not d.get("bars"):
        raise RuntimeError(d.get("error", "no bars"))
    return dedup_daily([(b["date"], float(b["close"])) for b in d["bars"] if b.get("close")])

def fetch_1600(symbol="NQ=F", days=12, interval=None):
    """분봉에서 매일 16:00 ET 이전 마지막 종가만 추출 (한국 05:00 기준)
       1분봉 전용 — 실패하면 그날 판정을 건너뛰고 다음 실행에서 재시도"""
    if interval is None:
        return fetch_1600(symbol, days, "1m")   # 1분봉 전용
    end = (et_now() + timedelta(days=1)).strftime("%Y-%m-%d")
    lookback = 6                                    # 야후 1분봉은 최근 5일만 제공
    start = (et_now() - timedelta(days=lookback)).strftime("%Y-%m-%d")
    url = (f"{HUNTER_API}/api/history?symbol={urllib.parse.quote(symbol)}"
           f"&start={start}&end={end}&interval={interval}&_={int(time.time())}")
    d = _get_json(url)
    if d.get("error") or not d.get("bars"):
        raise RuntimeError(d.get("error", f"no {interval} bars"))
    by_day = {}
    for b in d["bars"]:
        et_t = b.get("etTime")
        if not et_t or b.get("close") is None:
            continue
        hh, mm = (int(x) for x in et_t.split(":"))
        mins = hh * 60 + mm
        if mins > 16 * 60:          # 16:00 이후 제외
            continue
        day = b["date"]
        if day not in by_day or mins > by_day[day][0]:
            by_day[day] = (mins, float(b["close"]))
    globals()["_LAST_BAR_MIN"] = by_day[max(by_day)][0] if by_day else None
    globals()["_BAR_IV"] = interval
    out = [(k, v[1]) for k, v in sorted(by_day.items())]
    if len(out) < 4:
        raise RuntimeError("1분봉 부족")
    return out

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
        dt = datetime.fromtimestamp(t, et_tz())
        out.append((dt.strftime("%Y-%m-%d"), float(c)))
    return dedup_daily(out)

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
    return dedup_daily(out)[-days:]

def dedup_daily(bars):
    """같은 날짜가 여러 개면 마지막(가장 늦은) 값만 남긴다"""
    by = {}
    for d, c in bars:
        by[d] = c                      # 뒤에 오는 값이 덮어씀
    return [(k, by[k]) for k in sorted(by)]

def drop_intraday(bars):
    """미국 정규장 마감(16:00 ET) 전이면 당일 봉 제외 (서머타임 반영)"""
    if len(bars) < 2: return bars
    et = et_now()
    if bars[-1][0] == et.strftime("%Y-%m-%d") and et.hour < 16:
        return bars[:-1]
    return bars

def contract_symbols(code=None):
    """거래 월물의 야후 심볼 후보들"""
    code = code or active_contract()  # 예: MNQZ26
    M = {"H":"H","M":"M","U":"U","Z":"Z"}
    mth = code[-3]                    # Z
    yy  = code[-2:]                   # 26
    root_e = f"NQ{mth}{yy}"           # E-mini
    root_m = f"MNQ{mth}{yy}"          # Micro — 실제 거래 상품이라 우선
    return [f"{root_m}.CME", root_m, f"{root_e}.CME", root_e]

def get_prices(contract=None):
    """(당일종가, 전일종가, 그제종가, 날짜, 소스, 종가리스트)"""
    errs = []
    # 0-0) 한투 시세 — 실제 거래 상품과 동일 (LIVE 키가 있을 때만)
    if USE_KIS_QUOTE and KIS_KEY and KIS_SECRET:
        sym = contract or active_contract()
        # 16:00 ET(한국 05:00) 종가 — 한투 분봉
        if CLOSE_1600:
            try:
                b = kis_min_1600(sym)
                if len(b) >= 3 and b[-1][1] > 5000:
                    return b[-1][1], b[-2][1], b[-3][1], b[-1][0], f"{sym}/한투 16:00ET", [x[1] for x in b]
            except Exception as e:
                errs.append(f"KIS분봉: {str(e)[:150]}")
        # 한투 일봉은 17:00 ET 정산가라 05:00 기준과 어긋남 → 폴백에서 제외

    # 0-A) 거래 월물과 동일한 심볼 우선 (롤오버 갭 원천 차단)
    if USE_CONTRACT_SYM:
        for sym in contract_symbols(contract):
            try:
                b = fetch_1600(sym) if CLOSE_1600 else drop_intraday(fetch_hunter(sym))
                if len(b) >= 3 and b[-1][1] > 5000:
                    tag = f"{sym}{' 16:00ET' if CLOSE_1600 else ''}"
                    return b[-1][1], b[-2][1], b[-3][1], b[-1][0], tag, [x[1] for x in b]
            except Exception as e:
                errs.append(f"{sym}: {str(e)[:30]}")

    # 0-B) 만기 없는 지수 (폴백)
    if CLOSE_1600:
        try:
            b = fetch_1600(DATA_SYMBOL)
            if len(b) >= 3 and b[-1][1] > 5000:
                return b[-1][1], b[-2][1], b[-3][1], b[-1][0], f"{DATA_SYMBOL} 16:00ET", [x[1] for x in b]
        except Exception as e:
            errs.append(f"1600: {e}")
    # 1) 헌터 앱 (선물 직접)
    for sym in (DATA_SYMBOL, "NQ=F"):
        try:
            b = drop_intraday(fetch_hunter(sym))
            if len(b) >= 3 and b[-1][1] > 5000:
                return b[-1][1], b[-2][1], b[-3][1], b[-1][0], f"{sym}/hunter", [x[1] for x in b]
        except Exception as e:
            errs.append(f"hunter {sym}: {e}")

    # 2) 야후 (429 대비 재시도)
    for sym in (DATA_SYMBOL, "NQ=F"):
        for attempt in range(3):
            try:
                b = drop_intraday(fetch_yahoo(sym))
                if len(b) >= 3 and b[-1][1] > 5000:
                    return b[-1][1], b[-2][1], b[-3][1], b[-1][0], f"{sym}/yahoo", [x[1] for x in b]
            except Exception as e:
                errs.append(f"yahoo {sym} #{attempt+1}: {e}")
                time.sleep(3 * (attempt + 1))

    # 3) Stooq (^NDX 지수)
    sc_ndx = float(os.getenv("NDX_SCALE", "1.0"))
    try:
        b = drop_intraday(fetch_stooq("^ndx"))
        if len(b) >= 3 and b[-1][1] > 5000:
            return (b[-1][1]*sc_ndx, b[-2][1]*sc_ndx, b[-3][1]*sc_ndx,
                    b[-1][0], "^NDX/stooq", [x[1]*sc_ndx for x in b])
    except Exception as e:
        errs.append(f"stooq ^ndx: {e}")

    # 4) QQQ × 배율
    sc = float(os.getenv("QQQ_SCALE", "41.4"))
    for fn, tag in ((fetch_hunter, "hunter"), (fetch_stooq, "stooq"), (fetch_yahoo, "yahoo")):
        try:
            b = drop_intraday(fn("qqq.us" if tag == "stooq" else "QQQ"))
            if len(b) >= 3:
                return b[-1][1]*sc, b[-2][1]*sc, b[-3][1]*sc, b[-1][0], f"QQQ×{sc}/{tag}", [x[1]*sc for x in b]
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
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        det = ""
        try: det = e.read().decode("utf-8", "replace")[:300]
        except Exception: pass
        raise RuntimeError(f"토큰발급 HTTP {e.code} · {det}") from None
    if "access_token" not in d:
        raise RuntimeError(f"토큰발급 실패 · {str(d)[:200]}")
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
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode("utf-8", "replace")[:300]
        except Exception: pass
        raise RuntimeError(f"HTTP {e.code} · {body}") from None

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

def kis_daily(symbol=None, days=30):
    """한투 해외선물 일봉 조회 — 실제 거래 상품과 100% 동일
       tr_id=HHDFC55020100 / srs_cd=MNQZ26 / exch_cd=CME"""
    sym = symbol or active_contract()
    end = et_now().strftime("%Y%m%d")
    r = _kis_get("/uapi/overseas-futureoption/v1/quotations/daily-ccnl", "HHDFC55020100", {
        "SRS_CD": sym, "EXCH_CD": "CME",
        "START_DATE_TIME": "", "CLOSE_DATE_TIME": end,
        "QRY_TP": "Q", "QRY_CNT": str(min(days, 40)),
        "QRY_GAP": "", "INDEX_KEY": "",
    })
    if r.get("rt_cd") != "0":
        raise RuntimeError(r.get("msg1", "daily-ccnl 실패"))
    rows = r.get("output2") or []
    out = []
    for x in rows:
        d = x.get("data_date") or x.get("data_dt") or ""
        c = x.get("data_close") or x.get("ovrs_nmix_prpr") or x.get("last")
        if d and c:
            try:
                out.append((f"{d[:4]}-{d[4:6]}-{d[6:8]}", float(c)))
            except ValueError:
                pass
    out = dedup_daily(out)
    if len(out) < 4:
        raise RuntimeError(f"봉 부족 ({len(out)})")
    return out

def kis_min_1600(symbol=None, days=12):
    """한투 분봉에서 매일 16:00 ET 이전 마지막 종가 추출 (한국 05:00 기준)
       tr_id=HHDFC55020400 · index_key 로 페이징해 여러 날치를 모은다"""
    sym = symbol or active_contract()
    end = et_now().strftime("%Y%m%d")
    by_day, idx_key, qtp = {}, "", "Q"
    for page in range(12):                       # 최대 12회 페이징
        r = _kis_get("/uapi/overseas-futureoption/v1/quotations/inquire-time-futurechartprice",
                     "HHDFC55020400", {
            "SRS_CD": sym, "EXCH_CD": "CME",
            "START_DATE_TIME": "", "CLOSE_DATE_TIME": end,
            "QRY_TP": qtp, "QRY_CNT": "120", "QRY_GAP": MIN_GAP,
            "INDEX_KEY": idx_key,
        })
        if r.get("rt_cd") != "0":
            raise RuntimeError(r.get("msg1", "분봉 조회 실패"))
        rows = r.get("output2") or []
        if not isinstance(rows, list):
            rows = [rows]
        if not rows:
            break
        for x in rows:
            d = str(x.get("data_date") or "")
            t = str(x.get("data_time") or "").zfill(6)
            c = x.get("data_close") or x.get("last")
            if not (d and t and c):
                continue
            try:
                hh, mm = int(t[:2]), int(t[2:4]); px = float(c)
            except ValueError:
                continue
            if px <= 0:
                continue
            mins = hh*60 + mm
            if mins > 16*60:                     # 16:00 이후 제외
                continue
            key = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            if key not in by_day or mins > by_day[key][0]:
                by_day[key] = (mins, px)
        if len(by_day) >= days + 2:
            break
        o1 = r.get("output1") or {}
        idx_key = str(o1.get("index_key") or "")
        if not idx_key:
            break
        qtp = "P"
    log(f"분봉 {len(by_day)}일 수집 (페이지 {page+1})")
    if len(by_day) < 3:
        raise RuntimeError(f"분봉 부족 ({len(by_day)}일)")
    newest = max(by_day)
    globals()["_LAST_BAR_MIN"] = by_day[newest][0]
    return [(k, v[1]) for k, v in sorted(by_day.items())][-days:]


def kis_positions():
    """미결제 내역 조회  tr_id=OTFM1412R"""
    return _kis_get("/uapi/overseas-futureoption/v1/trading/inquire-unpd", "OTFM1412R", {
        "CANO": KIS_ACCT, "ACNT_PRDT_CD": KIS_PROD,
        "FUOP_DVSN": "01",                      # 01=선물
        "CTX_AREA_FK100": "", "CTX_AREA_NK100": "",
    })

def sync_from_broker(local_pos):
    """한투 실제 잔고로 포지션 동기화.
       수동 매매·부분청산이 있어도 실제 계좌를 기준으로 맞춘다."""
    r = kis_positions()
    if r.get("rt_cd") != "0":
        raise RuntimeError(r.get("msg1", "잔고조회 실패"))
    rows = r.get("output1") or r.get("output") or []
    sym = active_contract()
    held = 0
    avg = None
    for x in rows:
        code = str(x.get("ovrs_futr_fx_pdno") or x.get("pdno") or "")
        if SYMBOL not in code:
            continue
        q = int(float(x.get("ustl_qty") or x.get("cblc_qty") or 0))
        if q <= 0:
            continue
        held += q
        p = x.get("fm_ccld_pric") or x.get("avg_unpr") or x.get("pchs_avg_pric")
        if p:
            try: avg = float(p)
            except ValueError: pass

    local_q = sum(x["qty"] for x in local_pos)
    if held == local_q:
        return local_pos, None                       # 일치 — 그대로

    if held == 0:
        return [], f"계좌 0계약 · 봇 {local_q}계약 → 봇 기록 초기화"

    if held < local_q:
        # 실제가 적음 → 오래된 것부터 줄임
        pos = sorted(local_pos, key=lambda x: x["date"])
        need = local_q - held
        out = []
        for x in pos:
            if need <= 0: out.append(x); continue
            cut = min(x["qty"], need)
            x["qty"] -= cut; need -= cut
            if x["qty"] > 0: out.append(x)
        return out, f"계좌 {held}계약 · 봇 {local_q}계약 → 줄임"

    # 실제가 많음 → 수동 매수로 간주, 오늘 날짜로 추가
    extra = held - local_q
    today = et_now().strftime("%Y-%m-%d")
    local_pos.append({"entry": avg or 0, "date": today, "qty": extra, "m": "def"})
    return local_pos, f"계좌 {held}계약 · 봇 {local_q}계약 → {extra}계약 추가(수동매수 추정)"

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

def contract_info():
    """(월물코드, 만기일, 남은일수) — 만기 ROLL_STOP_DAYS 이내면 다음 월물로"""
    M = {3: "H", 6: "M", 9: "U", 12: "Z"}
    now = et_now().replace(tzinfo=None)
    for y in (now.year, now.year + 1):
        for q in (3, 6, 9, 12):
            exp = third_friday(y, q)
            if not exp or exp < now:
                continue
            d2e = (exp - now).days
            if d2e > ROLL_STOP_DAYS:
                return f"{SYMBOL}{M[q]}{str(y)[2:]}", exp, d2e
    return f"{SYMBOL}Z{str(now.year)[2:]}", None, 99

def data_expiry_days():
    """데이터 소스(야후 NQ=F = 최근월물)의 만기까지 남은 일수"""
    now = et_now().replace(tzinfo=None)
    for y in (now.year, now.year + 1):
        for q in (3, 6, 9, 12):
            exp = third_friday(y, q)
            if exp and exp >= now:
                return (exp - now).days
    return 99

def days_to_expiry():
    _, exp, d = contract_info()
    return d, exp

def active_contract(held_sym=None, has_pos=False):
    """보유 포지션이 있으면 그 월물을 유지, 없으면 새 월물로 전환"""
    new_sym, exp, d2e = contract_info()
    if has_pos and held_sym:
        return held_sym          # 정리될 때까지 기존 월물 유지
    return new_sym

# ─────────── 사다리 · 증거금 ───────────
def ladder_for(total, tiers=None, order=None):
    """총 계약수를 티어에 배분"""
    t = tiers or TIERS
    o = order or LAD_ORDER
    lad = [1]*t
    if o == "front":  seq = list(range(t))
    elif o == "back": seq = list(range(t))[::-1]
    else:             seq = sorted(range(t), key=lambda a: (abs(a-(t-1)/2), a))
    extra, k = total - t, 0
    while extra > 0:
        lad[seq[k % t]] += 1; extra -= 1; k += 1
    return lad

def margin_krw():
    return MARGIN_USD * FX

def plan_contracts(equity, unrealized=0.0):
    """자산 기준 총 계약수 결정 (백테와 동일 로직)"""
    mg = margin_krw()
    per_one = mg * (1 + BUFFER)
    gain = equity - INITIAL_CAP        # 납입금도 굴린다 (앱과 동일)
    want = TIERS + max(int(gain // PER_CONTRACT), 0) if PER_CONTRACT > 0 else TIERS
    afford = int((equity + unrealized) // per_one)
    return max(TIERS, min(want, afford)), want, afford

def room_for(equity, unrealized, held):
    """지금 더 살 수 있는 계약수 (증거금 기준)"""
    return max(0, int((equity + unrealized) // margin_krw()) - held)

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
    # 같은 거래일에 두 번 실행되면 두 번째는 스킵 (cron 2개 등록 대응)
    _et = et_now()
    log(f"MODE={MODE} FORCE_RUN={FORCE_RUN} PAUSE_BUY={PAUSE_BUY} "
        f"KIS={'Y' if (KIS_KEY and KIS_SECRET) else 'N'} ET={_et.strftime('%m-%d %H:%M')}")
    # ── 16:00 ET 마감까지 대기 ──
    # 04:55 KST 등 마감 직전에 시작된 실행은 정각까지 기다렸다가 바로 판정한다.
    if WAIT_CLOSE and not FORCE_RUN:
        _secs = (16*3600) - (_et.hour*3600 + _et.minute*60 + _et.second)
        if 0 < _secs <= WAIT_MAX_SEC:
            log(f"16:00 ET 까지 {_secs}초 대기 (현재 {_et.strftime('%H:%M:%S')} ET)")
            time.sleep(_secs + 8)          # 16:00 봉이 닫히도록 8초 여유
            _et = et_now()
            log(f"대기 완료 — 현재 {_et.strftime('%H:%M:%S')} ET")

    INTRADAY = _et.hour < 16          # 미국 장 마감 전 = 미리보기
    if INTRADAY and not FORCE_RUN:
        log(f"장 마감 전 ({_et.strftime('%H:%M')} ET) — 실행 스킵")
        return
    # cron이 2개(서머타임 대응)라 같은 날 두 번 돈다 — 시세 조회(토큰 발급) 전에 차단
    if not FORCE_RUN:
        _last = st.get("last_date")
        if _last and _last == _et.strftime("%Y-%m-%d"):
            log(f"{_last} 이미 처리됨 — 중복 실행 스킵 (사전 차단)")
            return

    pos = sorted(st["positions"], key=lambda x: x["date"])
    _pos0 = st.get("positions", [])
    _held_sym = st.get("contract")
    CONTRACT = active_contract(_held_sym, bool(_pos0))
    px, p1, p2, today, src, closes = get_prices(CONTRACT)
    if len(closes) >= 3 and (px == p1 or p1 == p2):
        log(f"⚠️ 종가 중복 의심: {px}/{p1}/{p2}")

    # ── 16:00 봉 완성 검사 ──
    _lbm = globals().get("_LAST_BAR_MIN")
    if not FORCE_RUN and "16:00ET" in src and _lbm is not None and _lbm < 16*60:
        _hh, _mm = divmod(_lbm, 60)
        msg = (f"⏳ <b>종가 미확정</b> — 마지막 봉 {_hh:02d}:{_mm:02d} ET "
               f"(16:00 미완성) · 다음 실행 대기")
        log(msg.replace("<b>","").replace("</b>",""))
        return

    # ── 시세 신선도 검사 ──
    # 마감 직후 실행인데 데이터 제공처가 아직 당일 일봉을 안 올렸으면
    # 어제 종가로 잘못 판정하게 된다 → 그런 날은 건너뛰고 다음 실행을 기다린다
    if not FORCE_RUN:
        _etd = _et.strftime("%Y-%m-%d")
        if today != _etd:
            _gap = (datetime.strptime(_etd, "%Y-%m-%d") - datetime.strptime(today, "%Y-%m-%d")).days
            if _gap >= 1 and _et.weekday() < 5:      # 평일인데 하루 이상 뒤처짐
                msg = (f"⏳ <b>시세 미갱신</b> — 조회된 종가가 {today} "
                       f"(오늘 {_etd}) · 판정 건너뜀")
                log(msg.replace("<b>","").replace("</b>",""))
                notify(msg)
                return

    # 같은 거래일을 이미 처리했으면 중복 실행 방지 (cron 2개 대응)
    if st.get("last_date") == today and not FORCE_RUN:
        log(f"{today} 이미 처리됨 — 중복 실행 스킵")
        return

    buy_thr  = flr(min(p1, p2) * (1 - BUY_PCT/100))    # 방어: 전일·그제
    # 추세 판정 (전일 종가 > MA)
    is_atk = False
    if ATK_ON and len(closes) > ATK_MA:
        sma = sum(closes[-(ATK_MA+1):-1]) / ATK_MA
        is_atk = p1 > sma
    atk_thr = cel(p1 * (1 + ATK_BUY/100)) if is_atk else None
    contract = CONTRACT

    lines = [f"<b>🎯 MNQ {MODE}</b>" + (" <i>(테스트)</i>" if FORCE_RUN else ""),
             f"{src} · {today} 종가 <b>{px:,.2f}</b>",
             f"월물 {contract} · 보유 {len(pos)}/{TIERS}티어", ""]
    _newsym = contract_info()[0]
    if _newsym != CONTRACT:
        lines.append(f"🔄 <b>{_newsym}로 전환 대기</b> — 보유분 정리 후 자동 전환")

    # ── 운용 스위치 ──
    if PAUSE_ALL:
        lines.append("⏸️ <b>전체 중단</b> (PAUSE_ALL=1) — 판정·주문 없음")
        if pos:
            lines.append(f"보유 {sum(x['qty'] for x in pos)}계약 유지 중")
        notify("\n".join(lines))
        return

    # ── LIVE: 실제 잔고와 동기화 (수동 개입 반영) ──
    if MODE == "LIVE" and KIS_KEY and KIS_SECRET:
        try:
            pos, msg = sync_from_broker(pos)
            if msg:
                lines.append(f"🔄 <b>잔고 동기화</b> — {msg}")
                st["positions"] = pos
                st["step"] = len(pos)
        except Exception as e:
            lines.append(f"⚠️ 잔고 조회 실패: {str(e)[:40]}")

    # ── 조건 판정 (종가 기준) → 충족분만 시장가 주문 ──
    moc = [x for x in pos if biz_days(x["date"], today) >= HOLD_DAYS]
    orders = []

    if CLOSE_ALL and pos:
        for x in pos:
            orders.append(("MOC", x["qty"], f"전량청산 지시 · {x['date']} 진입 {x['entry']:,.2f}"))
        lines.append("🛑 <b>전량 청산</b> (CLOSE_ALL=1)")
        moc = list(pos)

    if moc:
        # MOC 있는 날: MOC만 청산 (다른 매도 없음)
        for x in moc:
            orders.append(("MOC", x["qty"],
                           f"{x['date']} 진입 {x['entry']:,.2f} · {biz_days(x['date'],today)}일 경과"))
    else:
        # 익절 조건 충족한 티어만
        for i, x in enumerate(pos):
            pct = ATK_SELL if x.get("m") == "atk" else SELL_PCT
            sp = cel(x["entry"] * (1 + pct/100))
            if px >= sp:
                orders.append(("SELL", x["qty"],
                               f"T{i+1} 진입 {x['entry']:,.2f} → 기준 {sp:,.2f} 충족"))

    # ── 자본 · 계약수 계산 (백테와 동일) ──
    equity = st.get("equity", TOTAL_PAID)
    held   = sum(x["qty"] for x in pos)
    unreal = sum((px - x["entry"]) * MULT * x["qty"] * FX for x in pos)
    total_q, want_q, afford_q = plan_contracts(equity, unreal)
    lad = ladder_for(total_q)
    # 사이클 내 매수 횟수(step) — 포지션이 완전히 비면 0으로 리셋
    step = st.get("step", len(pos))
    if not pos: step = 0
    tier_idx = step
    want_buy = lad[tier_idx] if tier_idx < len(lad) else 0
    room = room_for(equity, unreal, held)
    buy_qty = min(want_buy, room)

    # 매수 조건 (만기 임박 시 신규 중단)
    # 실제 거래 중인 월물의 만기까지 남은 일수
    def _sym_days(sym):
        M={"H":3,"M":6,"U":9,"Z":12}
        try:
            q=M[sym[-3]]; y=2000+int(sym[-2:])
            e=third_friday(y,q)
            return (e - et_now().replace(tzinfo=None)).days if e else 99
        except Exception: return 99
    d2e = _sym_days(CONTRACT)
    exp_dt = None
    # 판정 데이터가 만기 없는 지수면 데이터 롤오버 차단 불필요
    d2e_data = 99 if DATA_SYMBOL.startswith("^") else data_expiry_days()
    roll_block = (d2e <= HOLD_DAYS + 2) or (d2e_data <= HOLD_DAYS + 1) or PAUSE_BUY
    use_atk = is_atk and step == 0            # T1 자리에서만 공격
    if use_atk:
        hit = px >= atk_thr; thr_show = atk_thr; mode_tag = "공격"
    else:
        hit = px <= buy_thr; thr_show = buy_thr; mode_tag = "방어"

    if step < TIERS and hit and not roll_block and buy_qty > 0:
        sign = "≥" if use_atk else "≤"
        tag = f" [{mode_tag}]" if ATK_ON else ""
        memo = f"T{len(pos)+1}{tag} · 종가 {px:,.2f} {sign} 기준 {thr_show:,.2f}"
        if buy_qty < want_buy:
            memo += f" · 증거금 부족 {want_buy}→{buy_qty}계약"
        orders.append(("BUY", buy_qty, memo))
    elif step < TIERS and hit and not roll_block and buy_qty == 0:
        lines.append(f"⚠️ <b>매수 조건 충족 · 증거금 부족으로 스킵</b>")
    elif roll_block and step < TIERS and hit:
        if PAUSE_BUY: why = "신규 매수 중단 설정 (PAUSE_BUY=1)"
        elif d2e_data <= HOLD_DAYS+1: why = f"데이터 월물 만기 D-{d2e_data}"
        else: why = f"거래 월물 만기 D-{d2e}"
        lines.append(f"⚠️ <b>{why} — 신규 매수 중단</b> (조건은 충족했음)")

    # 데이터 롤오버 경고
    if d2e_data <= HOLD_DAYS + 1:
        lines.append(f"🔄 <b>데이터 롤오버 구간</b> (NQ=F 월물 만기 D-{d2e_data}) — 신호 신뢰도 낮음")

    # 만기 임박 경고
    if roll_block and pos:
        lines.append(f"🔴 <b>만기 D-{d2e} — 보유 {len(pos)}티어 정리 필요</b>")

    # 출력
    lines.append(f"자산 <b>{equity/1e4:,.0f}만</b> · 구성 {'·'.join(map(str,lad))} ({total_q}계약)"
                 + (f" · 여유 {room}계" if room < 99 else ""))
    # 현재 설정 한 줄 — Variables가 제대로 들어갔는지 매일 눈으로 확인
    lines.append(f"⚙️ 복리 {PER_CONTRACT/1e4:,.0f}만 · 기준선 {INITIAL_CAP/1e4:,.0f}만 · "
                 f"{BUY_PCT}/{SELL_PCT} · {HOLD_DAYS}일 · {TIERS}티어")
    if PAUSE_BUY:
        lines.append("⏸️ <b>신규 매수 중단 중</b> (보유분은 정상 청산)")
    if is_atk:
        lines.append(f"📈 <b>상승 추세</b> (MA{ATK_MA} 위) — T1 공격모드")
        lines.append(f"기준가 · T1 매수 <code>{atk_thr:,.2f}</code> 이상 (공격)")
        lines.append(f"        T2~ 매수 <code>{buy_thr:,.2f}</code> 이하 (방어)")
    else:
        lines.append(f"기준가 · 매수 <code>{buy_thr:,.2f}</code> 이하")
    if pos and not moc:
        for i, x in enumerate(pos):
            _pct = ATK_SELL if x.get("m")=="atk" else SELL_PCT
            _d = biz_days(x["date"], today)
            _left = HOLD_DAYS - _d
            if _left <= 0:   _dd = " <b>오늘 MOC</b>"
            elif _left == 1: _dd = " <i>(내일 MOC)</i>"
            else:            _dd = f" <i>(D+{_d}, {_left}일 남음)</i>"
            lines.append(f"      T{i+1} 매도 <code>{cel(x['entry']*(1+_pct/100)):,.2f}</code> 이상{_dd}")
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

    # 매달 1일 납입 리마인더
    if datetime.now(timezone(timedelta(hours=9))).day <= 3:
        lines.append(f"\n💰 <i>이번 달 납입했으면 TOTAL_PAID 갱신 (현재 {TOTAL_PAID/1e4:,.0f}만)</i>")

    # ── 주문 마감 시각 검사 ──
    # 종가 직후에만 체결해야 백테와 맞는다. 지연되면 주문을 포기한다.
    _now = et_now()
    _late = (_now.hour*60 + _now.minute) - 16*60
    if orders and not FORCE_RUN and _late > ORDER_DEADLINE:
        lines.append(f"\n⛔ <b>주문 취소</b> — 16:{_late:02d} ET 경과 "
                     f"(마감 {ORDER_DEADLINE}분 초과) · 종가 괴리로 스킵")
        notify("\n".join(lines))
        return

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
                    pos.append({"entry": px, "date": today, "qty": q, "m": "atk" if use_atk else "def"})
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
        st["step"] = 0 if not pos else step + (1 if any(o[0]=="BUY" for o in orders) else 0)
        st["last_date"] = today
        st["contract"] = CONTRACT if pos else None
        st["cfg"] = {"buy_pct": BUY_PCT, "sell_pct": SELL_PCT, "hold": HOLD_DAYS,
                     "tiers": TIERS, "per": PER_CONTRACT/1e4, "lad": LAD_ORDER,
                     "margin_usd": MARGIN_USD, "fx": FX, "buffer": BUFFER*100,
                     "paid": TOTAL_PAID/1e4, "icap": INITIAL_CAP/1e4}
        st["quote"] = {"px": px, "p1": p1, "p2": p2, "date": today, "src": src,
                       "buy_thr": buy_thr, "contract": CONTRACT,
                       "total_q": total_q, "want": want_q, "afford": afford_q}
        if FORCE_RUN:
            log("FORCE_RUN — 상태 저장 생략 (테스트)")
        else:
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
                pos.append({"entry": px, "date": today, "qty": q, "m": "atk" if use_atk else "def"})
        st["positions"] = pos
        st["step"] = 0 if not pos else step + (1 if any(o[0]=="BUY" for o in orders) else 0)
        st["equity"] = TOTAL_PAID + st["realized"]
        st["last_date"] = today
        st["contract"] = CONTRACT if pos else None
        st["cfg"] = {"buy_pct": BUY_PCT, "sell_pct": SELL_PCT, "hold": HOLD_DAYS,
                     "tiers": TIERS, "per": PER_CONTRACT/1e4, "lad": LAD_ORDER,
                     "margin_usd": MARGIN_USD, "fx": FX, "buffer": BUFFER*100,
                     "paid": TOTAL_PAID/1e4, "icap": INITIAL_CAP/1e4}
        st["quote"] = {"px": px, "p1": p1, "p2": p2, "date": today, "src": src,
                       "buy_thr": buy_thr, "contract": CONTRACT,
                       "total_q": total_q, "want": want_q, "afford": afford_q}
        if FORCE_RUN:
            log("FORCE_RUN — 상태 저장 생략 (테스트)")
        else:
            save_state(st)
        log(f"누적 실현 ${st['realized']:,.0f} · 거래 {len(st['history'])}건")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        notify(f"❌ 봇 오류: {e}")
        raise
