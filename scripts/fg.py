"""Toob CNN Fear & Greed indeksi ja kirjutab data/fg.json (sama meetod mis kodutahvlis).
Apps Script loeb selle faili, sest CNN blokeerib Google'i serverid. Käivitab GitHub Actions."""
import json
import os
import urllib.request
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "fg.json")
URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": "https://edition.cnn.com/", "Origin": "https://edition.cnn.com",
    "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
}


def main():
    with urllib.request.urlopen(urllib.request.Request(URL, headers=HEADERS), timeout=30) as r:
        data = json.load(r)
    f = data["fear_and_greed"]
    hist = data.get("fear_and_greed_historical", {}).get("data", [])
    rnd = lambda v: round(v) if isinstance(v, (int, float)) else None
    out = {
        "s": round(f["score"], 1),
        "r": str(f.get("rating", "")),
        "e": rnd(f.get("previous_close")),
        "w": rnd(f.get("previous_1_week")),
        "m": rnd(f.get("previous_1_month")),
        "ts": str(f.get("timestamp", "")),
        "hist": [round(p["y"]) for p in hist[-30:]],
        "toodud": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    print("F&G", out["s"], out["r"])


if __name__ == "__main__":
    main()
