"""
실적 헤드라인 직후 주가 반응 검증용 데이터 받기 (알파카 뉴스 + 시간외 포함 1분봉)
  NEWS_SYMS : 실적 이벤트를 찾을 종목 (기본: SOXL 주요 구성 종목)
  START     : 기본 2016-01-01
출력: data/news_events.json.gz
  events: [{sym, t(UTC), headline}]  ← 'EPS ... Estimate' 형식 실적 헤드라인, 'CPI' 헤드라인
  bars  : {"SYM|YYYY-MM-DD": [[t(UTC), o, h, l, c, v], ...]}  ← 이벤트 날과 다음 거래일, 프리·애프터 포함
"""
import os, gzip, json, time, re, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

KEY, SEC = os.environ["ALPACA_KEY"], os.environ["ALPACA_SECRET"]
SYMS = [s.strip().upper() for s in os.getenv("NEWS_SYMS",
        "NVDA,AMD,AVGO,MU,INTC,QCOM,TSM,ASML,AMAT,LRCX,KLAC,MRVL,TXN,ADI,ON,NXPI,MCHP,SMCI").split(",") if s.strip()]
START = os.getenv("START", "2016-01-01")
os.makedirs("data", exist_ok=True)
H = {"APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC}

def get(url):
    for k in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            print("HTTP", e.code, e.read()[:200], flush=True)
            if e.code in (401, 403): raise
            time.sleep(3 * (k + 1))
        except Exception as e:
            print("오류", e, flush=True); time.sleep(3 * (k + 1))
    raise RuntimeError("반복 실패")

EPS = re.compile(r"\bEPS\b.*\b(Beat|Beats|Miss|Misses|In-Line|Inline|Up From|Down From)\b", re.I)
CPI = re.compile(r"\bCPI\b|Consumer Price", re.I)

def news(sym, rx):
    out, tok, n = [], None, 0
    while True:
        q = {"symbols": sym, "start": f"{START}T00:00:00Z", "limit": "50", "sort": "asc", "include_content": "false"}
        if tok: q["page_token"] = tok
        d = get("https://data.alpaca.markets/v1beta1/news?" + urllib.parse.urlencode(q))
        for a in d.get("news", []):
            n += 1
            h = a.get("headline", "")
            if rx.search(h): out.append({"sym": sym, "t": a["created_at"], "headline": h})
        tok = d.get("next_page_token")
        if not tok: break
        time.sleep(0.31)   # 분당 200회 제한
    print(sym, "기사", n, "매칭", len(out), flush=True)
    return out

events = []
for s in SYMS: events += news(s, EPS)
events += [dict(e, sym="MACRO") for e in news("SPY", CPI)]

def bars(sym, t0, t1):
    rows, tok = [], None
    while True:
        q = {"timeframe": "1Min", "start": t0, "end": t1, "limit": "10000", "adjustment": "split", "feed": "sip"}
        if tok: q["page_token"] = tok
        d = get(f"https://data.alpaca.markets/v2/stocks/{sym}/bars?" + urllib.parse.urlencode(q))
        rows += [[b["t"][:16], round(b["o"], 4), round(b["h"], 4), round(b["l"], 4), round(b["c"], 4), b["v"]] for b in (d.get("bars") or [])]
        tok = d.get("next_page_token")
        if not tok: return rows
        time.sleep(0.31)

B = {}
def want(sym, day):
    k = f"{sym}|{day}"
    if k in B: return
    d = datetime.fromisoformat(day).replace(tzinfo=timezone.utc)
    # 그날 프리장 시작(08:00 UTC 근사)부터 다음날 애프터 끝(+2일 01:00 UTC)까지. 무료 계정은 최근 15분 SIP 불가 → 20분 전까지만
    t0 = d + timedelta(hours=7)
    t1 = min(d + timedelta(days=2, hours=1), datetime.now(timezone.utc) - timedelta(minutes=20))
    if t1 <= t0: B[k] = []; return
    try:
        B[k] = bars(sym, t0.strftime("%Y-%m-%dT%H:%M:%SZ"), t1.strftime("%Y-%m-%dT%H:%M:%SZ"))
    except Exception as e:
        print("건너뜀", k, e, flush=True); B[k] = []

days = sorted({(e["sym"], e["t"][:10]) for e in events})
print("이벤트 날", len(days), flush=True)
for i, (sym, day) in enumerate(days):
    if sym != "MACRO": want(sym, day)
    want("SOXL", day)
    if i % 50 == 0: print(i, sym, day, flush=True)

with gzip.open("data/news_events.json.gz", "wt") as f:
    json.dump({"events": events, "bars": B}, f)
print("저장", len(events), "이벤트", len(B), "봉 묶음", flush=True)
