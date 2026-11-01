"""Write app/data/restrictions.json: open moving-truck permits on Beacon Hill,
each matched to the nearest curb. Runs at every deploy (and every few hours on
a schedule), so the file is generated, not committed.

Source: Analyze Boston "Moving Truck Permits" (street occupancy permits). The
data has an issue date and an expiration date but no move date, so the app
treats the last two days before expiration as the likely no-parking window.

Run: python tools/fetch_restrictions.py
"""
import datetime as dt
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
SEGMENTS = ROOT / "app" / "data" / "segments.json"
OUT = ROOT / "app" / "data" / "restrictions.json"
RESOURCE = "fde6709d-62a7-4523-a8eb-76eac2004f4b"
BBOX = (42.3530, 42.3635, -71.0745, -71.0580)     # lat min/max, lng min/max
MATCH_M = 25
ET = ZoneInfo("America/New_York")


def sql(query):
    url = "https://data.boston.gov/api/3/action/datastore_search_sql?" + urllib.parse.urlencode({"sql": query})
    req = urllib.request.Request(url, headers={"User-Agent": "beau-on-beacon-hill/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["result"]["records"]


def nearest_curb(curbs, lng, lat):
    kx, ky = 111320 * math.cos(math.radians(lat)), 110540
    best, best_d = None, float("inf")
    for c in curbs:
        pts = [(x * kx, y * ky) for x, y in c["line"]]
        px, py = lng * kx, lat * ky
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            dx, dy = bx - ax, by - ay
            t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) or 1)))
            d = math.hypot(ax + t * dx - px, ay + t * dy - py)
            if d < best_d:
                best, best_d = c, d
    return (best, best_d) if best_d <= MATCH_M else (None, best_d)


def main():
    curbs = json.load(open(SEGMENTS))["curbs"]
    today = dt.datetime.now(ET).date().isoformat()
    rows = sql(f'''SELECT permit_number, comments, issued_date, expiration_date, lat, long
        FROM "{RESOURCE}"
        WHERE expiration_date >= '{today}' AND status = 'OPEN' AND lat <> '' AND long <> ''
          AND CAST(lat AS float) BETWEEN {BBOX[0]} AND {BBOX[1]}
          AND CAST(long AS float) BETWEEN {BBOX[2]} AND {BBOX[3]}''')
    permits = []
    for r in rows:
        lat, lng = float(r["lat"]), float(r["long"])
        curb, dist = nearest_curb(curbs, lng, lat)
        # Permits are often issued weeks ahead; the truck is there near the end.
        issued = dt.datetime.fromisoformat(r["issued_date"][:10]).replace(tzinfo=ET)
        end = dt.datetime.fromisoformat(r["expiration_date"][:10]).replace(hour=23, minute=59, tzinfo=ET)
        start = max(issued, (end - dt.timedelta(days=2)).replace(hour=0, minute=0))
        permits.append({
            "id": r["permit_number"], "kind": "Moving truck", "curbId": curb["id"] if curb else None,
            "lat": round(lat, 6), "lng": round(lng, 6),
            "from": start.isoformat(), "to": end.isoformat(),
            "note": (r["comments"] or "").replace("\\", "").strip()[:120],
        })
    permits.sort(key=lambda p: p["to"])
    out = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "source": "City of Boston, Moving Truck Permits (Analyze Boston)", "permits": permits}
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    matched = sum(1 for p in permits if p["curbId"] is not None)
    print(f"{len(permits)} open permits on Beacon Hill, {matched} matched to a curb")


if __name__ == "__main__":
    main()
