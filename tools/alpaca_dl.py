"""
알파카에서 1분봉 받아서 정규장(09:30~16:00 ET)만 CSV.gz로 저장
  SYMBOLS  : 기본 SOXL,SOXX
  START    : 기본 2016-01-01
출력: data/<심볼>_1m.csv.gz  (컬럼: t(ET), o, h, l, c, v)
"""
import os, gzip, json, time, urllib.request, urllib.parse
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

KEY, SEC = os.environ["ALPACA_KEY"], os.environ["ALPACA_SECRET"]
SYMS  = [s.strip().upper() for s in os.getenv("SYMBOLS", "SOXL,SOXX").split(",") if s.strip()]
START = os.getenv("START", "2016-01-01")
ET = ZoneInfo("America/New_York")
os.makedirs("data", exist_ok=True)

def get(url):
    for k in range(6):
        try:
            req = urllib.request.Request(url, headers={"APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SEC})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            body = e.read()[:200]
            print("HTTP", e.code, body, flush=True)
            if e.code in (401, 403): raise
            time.sleep(5 * (k + 1))
        except Exception as e:
            print("오류", e, flush=True); time.sleep(5 * (k + 1))
    raise RuntimeError("반복 실패")

for sym in SYMS:
    out = gzip.open(f"data/{sym}_1m.csv.gz", "wt")
    out.write("t,o,h,l,c,v\n")
    tok, n, pages, last = None, 0, 0, ""
    while True:
        q = {"timeframe": "1Min", "start": f"{START}T00:00:00Z", "limit": "10000",
             "adjustment": "split", "feed": "sip", "sort": "asc"}
        if tok: q["page_token"] = tok
        d = get(f"https://data.alpaca.markets/v2/stocks/{sym}/bars?" + urllib.parse.urlencode(q))
        for b in d.get("bars") or []:
            t = datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(ET)
            m = t.hour * 60 + t.minute
            if 570 <= m < 960:                       # 정규장만
                out.write(f"{t:%Y-%m-%d %H:%M},{b['o']},{b['h']},{b['l']},{b['c']},{b['v']}\n")
                n += 1; last = f"{t:%Y-%m-%d}"
        pages += 1
        if pages % 50 == 0: print(f"{sym} {pages}페이지 · {n:,}봉 · {last}", flush=True)
        tok = d.get("next_page_token")
        if not tok: break
        time.sleep(0.35)                              # 분당 200회 한도 아래로
    out.close()
    print(f"✅ {sym}: {n:,}봉 ({START} ~ {last})", flush=True)
