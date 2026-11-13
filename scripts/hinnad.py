"""Varuhinnad: küsib serverilt tickerite nimekirja, toob Yahoo hinnad GitHubi serveritest (teine IP kui Apps Scriptil)
ja saadab need serverisse lehele "Hinnad GH". Midagi ei kirjutata repo sisse – tickerid ja hinnad jäävad privaatseks.
Vajab GitHubi secrets: PF_URL (Apps Scripti /exec link) ja PF_GH_VOTI (sama võti mis portfell-server.gs failis)."""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

URL = os.environ.get("PF_URL", "").strip()
VOTI = os.environ.get("PF_GH_VOTI", "").strip()
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}


def get_json(url, timeout=30):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.load(r)


def parse_chart(d, now):
    """Sama loogika mis serveri PF_parsiChart_: hind, eelmine sulgemine, nädal tagasi, aasta algus, 52n."""
    res = (d.get("chart") or {}).get("result") or []
    if not res:
        err = (d.get("chart") or {}).get("error") or {}
        raise ValueError(err.get("description") or "tühi vastus")
    res = res[0]
    meta = res.get("meta") or {}
    hind = meta.get("regularMarketPrice")
    if not isinstance(hind, (int, float)):
        raise ValueError("hind puudub")
    ts = res.get("timestamp") or []
    closes = (((res.get("indicators") or {}).get("quote") or [{}])[0] or {}).get("close") or []
    nihe = meta.get("gmtoffset") or 0
    paev = lambda s: (s + nihe) // 86400
    aasta = lambda s: datetime.fromtimestamp(s + nihe, timezone.utc).year
    turu = meta.get("regularMarketTime") or now
    tana, see_aasta, nadal_siht = paev(turu), aasta(turu), now - 7 * 86400
    eelmine = nadal = algus = esimene = None
    for i, s in enumerate(ts):
        c = closes[i] if i < len(closes) else None
        if c is None:
            continue
        if esimene is None:
            esimene = c
        if paev(s) < tana:
            eelmine = c
        if s <= nadal_siht:
            nadal = c
        if aasta(s) < see_aasta:
            algus = c
    if eelmine is None and isinstance(meta.get("previousClose"), (int, float)):
        eelmine = meta["previousClose"]
    nadal = esimene if nadal is None else nadal
    algus = esimene if algus is None else algus
    val = str(meta.get("currency") or "").strip()
    jag = 1
    if val in ("GBp", "GBX"):
        jag, val = 100, "GBP"
    f = lambda x: x / jag if isinstance(x, (int, float)) else None
    return {"nimi": meta.get("longName") or meta.get("shortName") or "", "valuuta": val.upper(), "hind": f(hind),
            "eelmine": f(eelmine), "nadal": f(nadal), "algus": f(algus),
            "max52": f(meta.get("fiftyTwoWeekHigh")), "min52": f(meta.get("fiftyTwoWeekLow"))}


def main():
    if not URL or not VOTI:
        sys.exit("PF_URL või PF_GH_VOTI secret puudub")
    q = urllib.parse.quote(json.dumps({"v": VOTI}))
    vastus = get_json(f"{URL}?a=ghTickerid&q={q}")
    if vastus.get("viga"):
        sys.exit("Server: " + vastus["viga"])
    tickerid = vastus.get("tickerid") or []
    now = int(time.time())
    p1 = int(datetime(datetime.now(timezone.utc).year - 1, 12, 15, tzinfo=timezone.utc).timestamp())
    hinnad, vead = {}, {}
    for t in tickerid:
        for host in ("query1", "query2"):
            try:
                d = get_json(f"https://{host}.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(t)}"
                             f"?period1={p1}&period2={now}&interval=1d", timeout=20)
                hinnad[t] = parse_chart(d, now)
                vead.pop(t, None)
                break
            except Exception as e:  # proovi teist hosti
                vead[t] = str(e)[:60]
        time.sleep(0.3)
    keha = json.dumps({"a": "ghHinnad", "v": VOTI, "hinnad": hinnad, "vead": vead}).encode()
    req = urllib.request.Request(URL, data=keha, headers={**UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        tulem = json.load(r)
    # Avaliku repo logid on kõigile nähtavad – tickerite nimesid ei logita, ainult arvud.
    print(f"{len(hinnad)}/{len(tickerid)} hinda saadetud, vigu {len(vead)}, server: {'OK' if tulem.get('ok') else 'viga'}")
    if tulem.get("viga"):
        sys.exit("Server: " + tulem["viga"])


if __name__ == "__main__":
    main()
