"""
MNQ 장중 봇 (노이즈 돌파 + VWAP 스탑) — i1.0

규칙 (백테와 동일)
  · 기준 위 = max(오늘 09:30 시가, 전일 16:00 종가), 기준 아래 = min(...)
  · 밴드 폭 σ(t) = 최근 14거래일, 같은 시각의 |가격/시가 − 1| 평균
  · 위 밴드 = 기준 위 × (1+σ), 아래 밴드 = 기준 아래 × (1−σ)
  · 10:00 ~ 15:30 ET 30분마다 (직전 1분봉 종가로 판단)
      없음 → 가격 > 위 밴드 & > VWAP : 롱   /  가격 < 아래 밴드 & < VWAP : 숏
      롱   → 가격 < max(위 밴드, VWAP) : 청산
      숏   → 가격 > min(아래 밴드, VWAP) : 청산   (청산한 체크에서는 재진입 안 함)
  · 15:59:30 ET 남은 포지션 전량 청산 (봇 16:00 판정 전에 반드시 0계약)

계약수 = round(자산 × INTRA_LEV ÷ (가격 × $2 × 환율)),
         단 증거금(버퍼 포함) − 봇 보유분 이내, INTRA_MAX 이하
자산   = TOTAL_PAID + 봇 실현손익 + 장중 실현손익

INTRA_MODE : OFF / PAPER(가상 체결, 알림만) / LIVE
"""
import os, sys, json, time, subprocess, urllib.parse
from datetime import datetime, timedelta, timezone
import mnq_bot as B

VER        = "i1.1"   # i1.1 계좌 순보유(숏 −) 기준으로 잔여 판단
IMODE      = (os.getenv("INTRA_MODE") or "PAPER").strip().upper()
LEV        = float(os.getenv("INTRA_LEV", "3.3"))
IMAX       = int(float(os.getenv("INTRA_MAX", "2")))
LB         = int(float(os.getenv("INTRA_LB", "14")))
USE_VWAP   = B._flag("INTRA_VWAP", "1")
STATE      = os.getenv("INTRA_STATE", "mnq_intra_state.json")
BOT_STATE  = os.getenv("STATE_FILE", "mnq_state.json")
SKIP_DAYS  = {x.strip() for x in os.getenv("INTRA_SKIP_DAYS", "2026-11-27,2026-12-24").split(",") if x.strip()}
TEST       = B._flag("INTRA_TEST", "0")         # 1이면 연결 점검만 하고 종료
BUDGET_MIN = float(os.getenv("INTRA_BUDGET_MIN", "345"))   # 한 번 실행에서 쓸 최대 시간(분)
CHECKS     = [(10, 0), (10, 30), (11, 0), (11, 30), (12, 0), (12, 30),
              (13, 0), (13, 30), (14, 0), (14, 30), (15, 0), (15, 30)]
CLOSE_AT   = (15, 59, 30)          # 봇(16:00 이후 시작)이 계좌를 읽기 전에 청산·저장 완료
T0         = time.time()
log, notify = B.log, B.notify

def hm(t): return f"{t[0]:02d}:{t[1]:02d}"
def mins(t): return t[0]*60 + t[1]

# ─────────── 상태 ───────────
def load():
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    return {"pos": 0, "qty": 0, "entry": None, "entry_t": None, "day": None,
            "done": [], "realized": 0.0, "trades": [], "hist": {}}

def save(s, msg="intra state"):
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    if os.getenv("GITHUB_ACTIONS") != "true":
        return
    for k in range(4):
        try:
            subprocess.run(["git", "add", STATE], check=True, capture_output=True)
            if subprocess.run(["git", "diff", "--staged", "--quiet"]).returncode == 0:
                return
            subprocess.run(["git", "commit", "-m", msg], check=True, capture_output=True)
            subprocess.run(["git", "pull", "--rebase"], capture_output=True)
            subprocess.run(["git", "push"], check=True, capture_output=True)
            return
        except Exception as e:
            log(f"상태 푸시 재시도 {k+1}: {str(e)[:80]}"); time.sleep(3)
    notify("⚠️ 장중 상태 저장(푸시) 실패 — 다음 실행이 포지션을 모를 수 있음")

def bot_state():
    try:
        with open(BOT_STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

# ─────────── 과거 밴드 (야후 5분봉, 헌터 API) ───────────
def fetch_hist(today):
    """최근 LB 거래일의 {date: {"o": 09:30 시가, "c": [체크 직전 가격 12개]}}"""
    et = B.et_now()
    start = (et - timedelta(days=LB*2 + 10)).strftime("%Y-%m-%d")
    end = (et + timedelta(days=1)).strftime("%Y-%m-%d")
    url = (f"{B.HUNTER_API}/api/history?symbol={urllib.parse.quote('NQ=F')}"
           f"&start={start}&end={end}&interval=5m&_={int(time.time())}")
    d = B._get_json(url, timeout=25)
    bars = d.get("bars") or []
    by = {}
    for b in bars:
        t = b.get("etTime"); c = b.get("close")
        if not t or c is None: continue
        hh, mm = (int(x) for x in t.split(":")[:2])
        by.setdefault(b["date"], {})[hh*60+mm] = (float(b.get("open") or c), float(c))
    out = {}
    for day, m in by.items():
        if day >= today or 570 not in m: continue
        o = m[570][0]
        cs = []
        for t in CHECKS:
            k = mins(t) - 5                     # 5분봉 (T-5 ~ T) 종가 = T 직전 가격
            if k not in m: break
            cs.append(m[k][1])
        if len(cs) == len(CHECKS):
            out[day] = {"o": o, "c": cs}
    return out

def sigma(hist, today):
    days = sorted(d for d in hist if d < today)[-LB:]
    if len(days) < LB:
        raise RuntimeError(f"밴드 계산용 과거 {len(days)}일 (필요 {LB}일)")
    return [sum(abs(hist[d]["c"][j]/hist[d]["o"] - 1) for d in days)/LB for j in range(len(CHECKS))]

# ─────────── 오늘 1분봉 (한투) ───────────
_KEYS = {"o": ("open_price", "data_open", "open", "oprc"),
         "h": ("high_price", "data_high", "high", "hgpr"),
         "l": ("low_price", "data_low", "low", "lwpr"),
         "c": ("last_price", "data_close", "close", "last", "close_price"),
         "v": ("last_qntt", "cntg_vol", "data_vol", "vol", "volume", "tvol")}
_logged = {"keys": False}

def _num(x, key):
    for k in _KEYS[key]:
        v = x.get(k)
        if v in (None, ""): continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if key == "v": return f
        for div in (1, 100, 10000):
            if 5000 < f/div < 200000: return f/div
    return None

def today_bars(sym, today):
    """오늘 09:30 ET 이후 1분봉 [(ET분, o,h,l,c,v)] — 시간대(ET/KST) 자동 판별"""
    et = B.et_now(); kst = datetime.utcnow() + timedelta(hours=9)
    raw, idx, qtp, off = [], "", "Q", None
    start930 = datetime.strptime(today, "%Y-%m-%d").replace(hour=9, minute=30)
    for page in range(8):
        p = {"SRS_CD": sym, "EXCH_CD": "CME", "QRY_TP": qtp, "QRY_CNT": "120",
             "QRY_GAP": "1", "INDEX_KEY": idx, "START_DATE_TIME": "", "CLOSE_DATE_TIME": ""}
        r = B._kis_get("/uapi/overseas-futureoption/v1/quotations/inquire-time-futurechartprice",
                       "HHDFC55020400", p)
        if r.get("rt_cd") != "0":
            raise RuntimeError(f"분봉 조회 실패: {r.get('msg1')}")
        rows, meta = [], {}
        for key in ("output2", "output1", "output"):
            o = r.get(key); lst = o if isinstance(o, list) else ([o] if isinstance(o, dict) else [])
            for x in lst:
                if isinstance(x, dict) and x.get("data_date"): rows.append(x)
                elif isinstance(x, dict) and not meta: meta = x
        if not rows: break
        if not _logged["keys"]:
            log("분봉 필드:", ",".join(sorted(rows[0].keys()))); _logged["keys"] = True
        for x in rows:
            d = str(x["data_date"]); t = str(x.get("data_time") or "").zfill(6)
            try:
                dt = datetime(int(d[:4]), int(d[4:6]), int(d[6:8]), int(t[:2]), int(t[2:4]))
            except ValueError:
                continue
            c = _num(x, "c")
            if c is None: continue
            raw.append((dt, _num(x, "o") or c, _num(x, "h") or c, _num(x, "l") or c, c, _num(x, "v")))
        if not raw: break
        if off is None:                                   # 첫 페이지에서 시간대 판별
            latest = max(b[0] for b in raw)
            is_kst = abs((kst - latest).total_seconds()) < abs((et.replace(tzinfo=None) - latest).total_seconds())
            off = timedelta(hours=(13 if B.us_dst() else 14)) if is_kst else timedelta(0)
        if min(b[0] for b in raw) - off <= start930:      # 오늘 09:30 ET 까지 받았으면 충분
            break
        idx = str((meta or {}).get("index_key") or "")
        if not idx: break
        qtp = "P"; time.sleep(0.2)
    if not raw:
        raise RuntimeError("오늘 분봉 없음")
    is_kst = off != timedelta(0)
    seen, out = set(), []
    for b in sorted(raw, key=lambda z: z[0]):
        e = b[0] - off
        if e.strftime("%Y-%m-%d") != today: continue
        m = e.hour*60 + e.minute
        if m < 570 or m >= 960 or m in seen: continue
        seen.add(m); out.append((m,) + b[1:])
    # 거래량이 누적값으로 오면 분당 거래량으로 변환
    vs = [b[5] for b in out if b[5] is not None]
    if len(vs) > 5 and all(vs[i] <= vs[i+1] for i in range(len(vs)-1)) and vs[-1] > 20*max(1, vs[0]):
        prev = None; conv = []
        for b in out:
            v = b[5]; dv = (v - prev) if (v is not None and prev is not None) else v
            prev = v if v is not None else prev
            conv.append(b[:5] + (max(dv or 0, 0),))
        out = conv
    return out, ("KST" if is_kst else "ET")

def vwap(bars, upto):
    num = den = 0.0
    for m, o, h, l, c, v in bars:
        if m > upto: break
        w = v if v and v > 0 else None
        if w is None: return None
        num += (h + l + c)/3 * w; den += w
    return num/den if den > 0 else None

# ─────────── 판단 (백테와 같은 함수) ───────────
def decide(pos, p, ub, lo, vw):
    """반환: 'EXIT' / 'LONG' / 'SHORT' / None"""
    if pos == 1:
        s = max(ub, vw) if (USE_VWAP and vw) else ub
        return "EXIT" if p < s else None
    if pos == -1:
        s = min(lo, vw) if (USE_VWAP and vw) else lo
        return "EXIT" if p > s else None
    if p > ub and (not USE_VWAP or not vw or p > vw): return "LONG"
    if p < lo and (not USE_VWAP or not vw or p < vw): return "SHORT"
    return None

# ─────────── 주문 ───────────
def order(side, qty, sym, why):
    if IMODE != "LIVE":
        log(f"[PAPER] {side} {qty} {sym} · {why}")
        return True
    for k in range(3):
        try:
            r = B.kis_order(side, qty, sym)
            if r.get("rt_cd") == "0":
                log(f"주문 OK {side} {qty} {sym} · {r.get('msg1','')}")
                return True
            log(f"주문 거부 {k+1}: {r.get('msg1')}")
        except Exception as e:
            log(f"주문 오류 {k+1}: {str(e)[:120]}")
        time.sleep(2)
    notify(f"🚨 장중 주문 실패 {side} {qty} {sym} ({why}) — 수동 확인 필요")
    return False

def contracts(st, bst, px):
    fx = B.FX; mg = B.MARGIN_USD * fx * (1 + B.BUFFER)
    eq = B.TOTAL_PAID + float(bst.get("realized") or 0) + float(st.get("realized") or 0)
    held = sum(int(x.get("qty", 0)) for x in (bst.get("positions") or []))
    n = int(round(eq * LEV / (px * B.MULT * fx)))
    room = int(eq // mg) - held
    return max(0, min(n, room, IMAX)), eq, held, room

def pnl_krw(pos, qty, e, x):
    return (x - e) * pos * qty * B.MULT * B.FX

def broker_held():
    """계좌 MNQ 순보유 (롱 +, 숏 −). 조회 실패·빈 응답이면 None (확실하지 않음)"""
    try:
        net, _avg, n = B.broker_net()
        if n == 0: return None                         # 빈 응답은 0계약인지 조회 오류인지 구분 불가
        return net
    except Exception as e:
        log(f"계좌 조회 실패: {str(e)[:100]}"); return None

def emergency(st, bst, sym, why):
    """남은 장중 포지션 비상 처리 — 계좌를 확실히 읽었을 때만 주문, 아니면 알림만"""
    botq = sum(int(x.get("qty", 0)) for x in (bst.get("positions") or []))
    if IMODE == "LIVE":
        held = broker_held()
        if held is None:
            notify(f"🚨 장중 기록 {st['pos']}×{st['qty']} 남음 ({why}) — 계좌 조회 불확실해서 주문 안 함. 수동 확인 필요")
            st.update(pos=0, qty=0, entry=None, entry_t=None); return
        if held == botq:
            notify(f"ℹ️ 장중 기록엔 포지션이 있지만 계좌엔 없음 — 기록만 정리 ({why})")
            st.update(pos=0, qty=0, entry=None, entry_t=None); return
    notify(f"🚨 장중 포지션 남음 ({st['pos']}×{st['qty']}, {st.get('day')}) — {why}")
    try: px = B.kis_now_price(sym)
    except Exception: px = st["entry"]
    close_pos(st, sym, px, why)

def close_pos(st, sym, px, why):
    side = "SELL" if st["pos"] == 1 else "BUY"
    if not order(side, st["qty"], sym, why):
        return False
    p = pnl_krw(st["pos"], st["qty"], st["entry"], px)
    st["realized"] += p
    st["trades"].append({"d": st["day"], "in": st["entry_t"], "out": why, "side": st["pos"],
                         "q": st["qty"], "e": st["entry"], "x": px, "pnl": round(p)})
    st["trades"] = st["trades"][-200:]
    notify(f"{'🟢' if p >= 0 else '🔴'} 장중 청산 [{IMODE}] {'롱' if st['pos']==1 else '숏'} {st['qty']}계약\n"
           f"{st['entry']:,.2f} → {px:,.2f} ({(px-st['entry'])*st['pos']:+.2f}pt)\n"
           f"손익 {p/1e4:+,.1f}만 · 사유 {why}")
    st.update(pos=0, qty=0, entry=None, entry_t=None)
    return True

# ─────────── 메인 ───────────
def wait_until(h, m, s=0):
    while True:
        e = B.et_now()
        left = (h*3600 + m*60 + s) - (e.hour*3600 + e.minute*60 + e.second)
        if left <= 0: return
        time.sleep(min(left, 30))

def self_test(st, bst, sym, today):
    """연결 점검: 야후 과거 밴드 · 한투 토큰/분봉/현재가 · 텔레그램"""
    out = [f"🧪 웨이브 점검 {VER} · MODE={IMODE} · 계약 {sym}"]
    try:
        h = fetch_hist(today); days_ = sorted(h)
        out.append(f"✅ 야후 5분봉: {len(days_)}일 ({days_[0] if days_ else '-'} ~ {days_[-1] if days_ else '-'})")
        st["hist"].update(h); sg = sigma(st["hist"], today)
        out.append(f"✅ 밴드 폭: 10:00 {sg[0]*100:.2f}% · 13:00 {sg[6]*100:.2f}% · 15:30 {sg[-1]*100:.2f}%")
    except Exception as e:
        out.append(f"❌ 과거 밴드: {str(e)[:120]}")
    try:
        B.kis_token(); out.append("✅ 한투 토큰")
    except Exception as e:
        out.append(f"❌ 한투 토큰: {str(e)[:120]}")
    try:
        p = {"SRS_CD": sym, "EXCH_CD": "CME", "QRY_TP": "Q", "QRY_CNT": "5", "QRY_GAP": "1",
             "INDEX_KEY": "", "START_DATE_TIME": "", "CLOSE_DATE_TIME": ""}
        r = B._kis_get("/uapi/overseas-futureoption/v1/quotations/inquire-time-futurechartprice", "HHDFC55020400", p)
        rows = [x for k in ("output2", "output1", "output") for x in (r.get(k) if isinstance(r.get(k), list) else []) if isinstance(x, dict) and x.get("data_date")]
        if rows:
            x = rows[0]
            out.append(f"✅ 한투 1분봉: {x.get('data_date')} {x.get('data_time')} · 종가 {_num(x,'c')} · 거래량 {_num(x,'v')}")
            out.append("   필드: " + ",".join(sorted(x.keys()))[:300])
            if _num(x, "v") is None: out.append("⚠️ 거래량 필드 없음 → VWAP 없이 밴드만으로 판단")
        else:
            out.append(f"❌ 한투 1분봉 비어 있음: {r.get('msg1')}")
    except Exception as e:
        out.append(f"❌ 한투 1분봉: {str(e)[:120]}")
    try:
        out.append(f"✅ 한투 현재가: {B.kis_now_price(sym):,.2f}")
    except Exception as e:
        out.append(f"⚠️ 한투 현재가: {str(e)[:100]}")
    n, eq, held, room = contracts(st, bst, float((bst.get('quote') or {}).get('px') or 30000))
    out.append(f"ℹ️ 자산 {eq/1e4:,.0f}만 · 봇 {held}계약 · 여유 {room} → 장중 {n}계약")
    msg = "\n".join(out); log(msg); notify(msg)

def main():
    if IMODE == "OFF":
        log("INTRA_MODE=OFF — 종료"); return
    subprocess.run(["git", "pull", "--rebase"], capture_output=True)
    st, bst = load(), bot_state()
    et = B.et_now(); today = et.strftime("%Y-%m-%d"); now_m = et.hour*60 + et.minute
    log(f"장중봇 {VER} · MODE={IMODE} · LEV={LEV} · MAX={IMAX} · VWAP={'Y' if USE_VWAP else 'N'} · ET {et:%m-%d %H:%M:%S}")
    sym = bst.get("contract") or B.active_contract()

    # 전날 포지션이 남아 있으면 비상 청산
    if st.get("pos") and st.get("day") != today:
        emergency(st, bst, sym, "이월 비상청산"); save(st, "intra: emergency close")

    if TEST:
        return self_test(st, bst, sym, today)
    if et.weekday() >= 5 or today in SKIP_DAYS:
        log("주말/휴장·단축일 — 종료"); return
    if now_m*60 + et.second >= CLOSE_AT[0]*3600 + CLOSE_AT[1]*60 + CLOSE_AT[2]:
        if st.get("pos") and st.get("day") == today:
            emergency(st, bst, sym, "지연 비상청산"); save(st, "intra: late close")
        log("청산 시각 이후 — 종료"); return
    if st.get("day") != today:
        st.update(day=today, done=[], pos=0, qty=0, entry=None, entry_t=None, op=None)

    # 밴드
    try:
        h = fetch_hist(today); st["hist"].update(h)
    except Exception as e:
        log(f"야후 5분봉 실패 — 저장된 기록 사용: {str(e)[:120]}")
    st["hist"] = {k: st["hist"][k] for k in sorted(st["hist"])[-40:]}
    sig = sigma(st["hist"], today)
    q = bst.get("quote") or {}
    prev = float(q["px"]) if q.get("px") and q.get("date") and q["date"] < today else None
    if prev is None:
        prev = st["hist"][max(st["hist"])]["c"][-1]
        log(f"전일 종가: 봇 기록 없음 → 야후 15:30 가격 {prev:,.2f} 사용")

    # 처리할 체크 — 이번 실행 시간 한도 안에 끝낼 수 있는 것만 (나머지는 다음 실행)
    def et_sec(t): return t[0]*3600 + t[1]*60 + (t[2] if len(t) > 2 else 0)
    now_s = et.hour*3600 + et.minute*60 + et.second
    limit_s = now_s + BUDGET_MIN*60 - 60
    todo = [t for t in CHECKS if hm(t) not in st["done"] and et_sec(t) >= now_s and et_sec(t) <= limit_s]
    do_close = et_sec(CLOSE_AT) <= limit_s + 60
    log(f"이번 실행: {', '.join(hm(t) for t in todo) or '없음'}{' + 15:59:30 청산' if do_close else ' (청산은 다음 실행)'}")

    op = None
    for t in todo:
        wait_until(t[0], t[1], 4)
        j = CHECKS.index(t)
        bars = []
        for k in range(6):                             # 직전 1분봉이 들어올 때까지 최대 30초
            try:
                bars, tz = today_bars(sym, today)
            except Exception as e:
                log(f"분봉 실패 {k+1}: {str(e)[:100]}"); bars = []
            if bars and bars[-1][0] >= mins(t) - 1: break
            time.sleep(5)
        if bars and bars[0][0] == 570:
            op = bars[0][1]; st["op"] = op
        elif st.get("op"):
            op = st["op"]                               # 앞 체크에서 저장한 시가
        if not bars or op is None or bars[-1][0] < mins(t) - 10:
            log(f"{hm(t)} 오늘 분봉/시가 없음 — 건너뜀"); continue
        last = [b for b in bars if b[0] <= mins(t) - 1][-1]
        p = last[4]
        if last[0] < mins(t) - 3:
            log(f"⚠️ 분봉 지연 ({last[0]//60:02d}:{last[0]%60:02d}) — 실시간가로 대체")
            try: p = B.kis_now_price(sym)
            except Exception: pass
        vw = vwap(bars, mins(t) - 1) if bars[0][0] == 570 else None
        if USE_VWAP and vw is None:
            log("⚠️ VWAP 계산 불가 (09:30부터 분봉·거래량 필요) — 밴드만으로 판단")
        ub = max(op, prev) * (1 + sig[j]); lo = min(op, prev) * (1 - sig[j])
        act = decide(st["pos"], p, ub, lo, vw)
        log(f"{hm(t)} 가격 {p:,.2f} · 위 {ub:,.2f} · 아래 {lo:,.2f} · VWAP {vw and f'{vw:,.2f}'} · 포지션 {st['pos']}×{st['qty']} → {act or '유지'}")
        if act == "EXIT":
            close_pos(st, sym, p, f"{hm(t)} 밴드/VWAP 이탈")
        elif act in ("LONG", "SHORT"):
            n, eq, held, room = contracts(st, bst, p)
            if n <= 0:
                log(f"계약 0 (자산 {eq/1e4:,.0f}만 · 봇 {held}계약 · 여유 {room})")
            elif order("BUY" if act == "LONG" else "SELL", n, sym, f"{hm(t)} 진입"):
                st.update(pos=1 if act == "LONG" else -1, qty=n, entry=p, entry_t=hm(t))
                notify(f"{'📈' if act=='LONG' else '📉'} 장중 {'롱' if act=='LONG' else '숏'} [{IMODE}] {n}계약 @ {p:,.2f}\n"
                       f"{hm(t)} ET · 위 {ub:,.2f} / 아래 {lo:,.2f} / VWAP {vw and f'{vw:,.2f}'}")
        if t == CHECKS[-1]:
            bm = {b[0]: b for b in bars}
            if 570 in bm and all(mins(c)-1 in bm for c in CHECKS):
                st["hist"][today] = {"o": bm[570][1], "c": [bm[mins(c)-1][4] for c in CHECKS]}
        st["done"].append(hm(t)); save(st, f"intra {hm(t)}")

    if do_close:
        wait_until(*CLOSE_AT)
        if st["pos"]:
            try: px = B.kis_now_price(sym)
            except Exception:
                bars, _ = today_bars(sym, today); px = bars[-1][4]
            if not close_pos(st, sym, px, "15:59:30 종가청산"):
                notify("🚨🚨 장중 종가청산 실패 — 16:00 봇 판정 전에 수동 청산 필요")
        save(st, "intra close")                      # 봇 시작 전에 바로 저장
        dp = sum(x["pnl"] for x in st["trades"] if x["d"] == today)
        n = sum(1 for x in st["trades"] if x["d"] == today)
        notify(f"📊 장중 마감 [{IMODE}] {today}\n오늘 {n}회 · {dp/1e4:+,.1f}만 · 누적 {st['realized']/1e4:+,.1f}만")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        notify(f"❌ 장중봇 오류: {e}")
        raise
