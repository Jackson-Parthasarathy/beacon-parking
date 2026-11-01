"""Build app/data/segments.json from City of Boston open data.

Inputs (tools/raw/, fetched by tools/fetch_raw.sh):
  sweeping.csv        Analyze Boston "Street Sweeping Schedules"
  segments.geojson    SAM street segments (centerlines with L/R address ranges)
  addresses.geojson   SAM address points (fallback for side parity)
  meters.geojson      Parking meters (metered curbs are not resident parking)
  snowroutes.geojson  Snow emergency arteries
  snowparking.geojson Discounted snow emergency garages

Each sweeping row becomes one curb: a street, a side (Odd, Even, or Both),
a cross-street span, a schedule, and a polyline offset toward that side.

Run: python tools/build_data.py
"""
import json
import math
import re
from collections import defaultdict
from pathlib import Path

import pandas as pd
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.ops import linemerge

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT.parent / "app" / "data" / "segments.json"

DISTRICTS = ["Beacon Hill"]
CURB_OFFSET_M = 4.0
NODE_SNAP_M = 12.0

to_m = Transformer.from_crs(4326, 26986, always_xy=True).transform
to_ll = Transformer.from_crs(26986, 4326, always_xy=True).transform

TYPE_ABBR = {"ST": "St", "PL": "Pl", "WAY": "Way", "SQ": "Sq", "AVE": "Ave",
             "LN": "Ln", "RD": "Rd", "CT": "Ct", "DR": "Dr", "ALY": "Aly"}
ALIASES = {
    "mt vernon": "mount vernon st",
    "mount vernon": "mount vernon st",
    "mt vernon st": "mount vernon st",
    "mt vernon pl": "mount vernon pl",
    "public alley 301": "public alley no. 301",
    "david g mugar way": "david g mugar way",
}


def norm(name):
    n = re.sub(r"\s+", " ", str(name).strip().lower())
    return ALIASES.get(n, n)


PRE_DIR = {"N": "North", "S": "South", "E": "East", "W": "West"}


def seg_name(p):
    body = p.get("ST_NAME") or ""
    if p.get("PRE_DIR"):
        body = f"{PRE_DIR.get(p['PRE_DIR'], p['PRE_DIR'])} {body}"
    t = p.get("ST_TYPE")
    full = f"{body} {TYPE_ABBR.get(t, t)}" if t and t != "None" else body
    return norm(full)


def project(coords):
    return [to_m(x, y) for x, y in coords]


def unproject(coords):
    return [[round(c, 6) for c in to_ll(x, y)] for x, y in coords]


def parity(*vals):
    for v in vals:
        try:
            n = int(re.match(r"\d+", str(v)).group())
            return "Odd" if n % 2 else "Even"
        except (AttributeError, TypeError, ValueError):
            continue
    return None


def side_of(line, pt):
    """+1 if pt is left of the line's local direction, -1 if right."""
    d = line.project(pt)
    a = line.interpolate(max(d - 1, 0))
    b = line.interpolate(min(d + 1, line.length))
    cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x)
    return 1 if cross > 0 else -1


# ---------------------------------------------------------------- load
sweep = pd.read_csv(RAW / "sweeping.csv", dtype=str)
sweep = sweep[sweep.dist_name.isin(DISTRICTS)].copy()

segs = []
for f in json.load(open(RAW / "segments.geojson"))["features"]:
    g = f["geometry"]
    if not g:
        continue
    parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
    for part in parts:
        p = f["properties"]
        segs.append({
            "name": seg_name(p),
            "line": LineString(project(part)),
            "l": parity(p.get("L_F_ADD"), p.get("L_T_ADD")),
            "r": parity(p.get("R_F_ADD"), p.get("R_T_ADD")),
        })
by_name = defaultdict(list)
for s in segs:
    by_name[s["name"]].append(s)

addr_by_street = defaultdict(list)
addr_numbers = defaultdict(dict)   # street -> house number -> Point
for f in json.load(open(RAW / "addresses.geojson"))["features"]:
    p = f["properties"]
    if f["geometry"] and p.get("STREET_NUMBER"):
        pt = Point(to_m(*f["geometry"]["coordinates"]))
        street_key = norm(p["FULL_STREET_NAME"])
        addr_by_street[street_key].append((pt, parity(p["STREET_NUMBER"])))
        num = str(p["STREET_NUMBER"]).strip()
        if re.fullmatch(r"\d+[A-Z]?", num):
            addr_numbers[street_key].setdefault(num, pt)

meters_by_street = defaultdict(list)
for f in json.load(open(RAW / "meters.geojson"))["features"]:
    p = f["properties"]
    if p.get("SPACE_STATE") == "ACTIVE" and p.get("STREET"):
        st = norm(re.sub(r"\s+[A-Z]+-[A-Z]+$", "", p["STREET"]).title())
        meters_by_street[st].append(Point(to_m(p["LONGITUDE"], p["LATITUDE"])))

snow_lines = []
for f in json.load(open(RAW / "snowroutes.geojson"))["features"]:
    g = f["geometry"]
    parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
    for part in parts:
        snow_lines.append((norm(f["properties"]["FULL_NAME"]), LineString(project(part)), part))


# ---------------------------------------------------------------- graph
def key(pt):
    return (round(pt[0] / 2) * 2, round(pt[1] / 2) * 2)


def street_graph(name):
    adj = defaultdict(list)
    for s in by_name.get(name, []):
        c = list(s["line"].coords)
        a, b = key(c[0]), key(c[-1])
        adj[a].append((b, s, False))
        adj[b].append((a, s, True))
    return adj


def cross_nodes(adj, cross):
    """Nodes of this street that touch the cross street."""
    if norm(cross) == "dead end":
        return [n for n, e in adj.items() if len(e) == 1]
    others = by_name.get(norm(cross), [])
    if not others:
        return []
    found = []
    for n in adj:
        pt = Point(n)
        if min(o["line"].distance(pt) for o in others) <= NODE_SNAP_M:
            found.append(n)
    return found


def shortest(adj, a, b):
    import heapq
    dist, prev, pq = {a: 0.0}, {}, [(0.0, a)]
    while pq:
        d, n = heapq.heappop(pq)
        if n == b:
            break
        if d > dist.get(n, 1e18):
            continue
        for m, s, rev in adj[n]:
            nd = d + s["line"].length
            if nd < dist.get(m, 1e18):
                dist[m], prev[m] = nd, (n, s, rev)
                heapq.heappush(pq, (nd, m))
    if b not in dist:
        return None, None
    path, n = [], b
    while n != a:
        p, s, rev = prev[n]
        path.append((s, rev))
        n = p
    return dist[b], path[::-1]


def curb_path(row):
    name = norm(row.st_name)
    adj = street_graph(name)
    if not adj:
        return None, "street not in segments"
    A, B = cross_nodes(adj, row["from"]), cross_nodes(adj, row["to"])
    if not A or not B:
        return None, f"cross street not found ({row['from']} / {row['to']})"
    target = float(row.miles or 0) * 1609.34
    best = None
    for a in A:
        for b in B:
            if a == b:
                continue
            d, path = shortest(adj, a, b)
            if path is None:
                continue
            score = abs(d - target) if target > 0 else d
            if best is None or score < best[0]:
                best = (score, d, path)
    if not best:
        return None, "no path between cross streets"
    return best[2], None


# ---------------------------------------------------------------- side
def side_sign(path_line, path, street, side):
    """Which side of the merged path line the requested curb is on."""
    if side in ("Odd", "Even"):
        votes = 0
        for s, rev in path:
            # L/R ranges are relative to the segment's digitized direction;
            # a reversed segment flips them relative to the path.
            for sgn, par in ((1, s["l"]), (-1, s["r"])):
                if par:
                    votes += (1 if par == side else -1) * (-sgn if rev else sgn)
        if votes == 0:
            for pt, par in addr_by_street.get(street, []):
                if par and path_line.distance(pt) < 40:
                    votes += (1 if par == side else -1) * side_of(path_line, pt)
        return (1 if votes > 0 else -1) if votes else 0
    if side == "Residential":
        votes = sum(side_of(path_line, pt) for pt, _ in addr_by_street.get(street, [])
                    if path_line.distance(pt) < 40)
        return 1 if votes > 0 else -1
    if side == "Boston Common":
        return -side_sign(path_line, path, street, "Residential")
    return 0


DISPLAY = {"mount vernon st": "Mount Vernon St"}


def compass(center, curb):
    """North/south/east/west side of the street the curb sits on."""
    a = center.interpolate(0.5, normalized=True)
    b = curb.interpolate(curb.project(a))
    dx, dy = b.x - a.x, b.y - a.y
    if abs(dx) > abs(dy):
        return "east" if dx > 0 else "west"
    return "north" if dy > 0 else "south"


def address_side(path_line, street, side):
    votes = 0
    for pt, par in addr_by_street.get(street, []):
        if par and path_line.distance(pt) < 40:
            votes += (1 if par == side else -1) * side_of(path_line, pt)
    return (1 if votes > 0 else -1) if votes else 0


def curb_addresses(line, street, side):
    """House numbers along this curb (matching parity), for "near 42 Chestnut St"."""
    out = []
    for num, pt in addr_numbers.get(street, {}).items():
        if side in ("Odd", "Even") and parity(num) != side:
            continue
        along = line.project(pt)
        if line.distance(pt) < 30 and 0 < along < line.length:
            x, y = to_ll(pt.x, pt.y)
            out.append([num, round(x, 5), round(y, 5)])
    return sorted(out, key=lambda a: int(re.match(r"\d+", a[0]).group()))


rows, problems, disagree = [], [], []
for _, row in sweep.iterrows():
    street = norm(row.st_name)
    side_raw = row.side if isinstance(row.side, str) else "Both"
    path, err = curb_path(row)
    if err:
        problems.append(f"{row.main_id} {row.st_name} {side_raw} {row['from']}-{row['to']}: {err}")
        continue
    coords = []
    for s, rev in path:
        c = list(s["line"].coords)
        c = c[::-1] if rev else c
        coords.extend(c if not coords else c[1:])
    line = LineString(coords)
    sign = side_sign(line, path, street, side_raw)
    if side_raw in ("Odd", "Even"):
        # Building address points beat segment address ranges, which are
        # flipped on a few streets (Walnut, Willow, Myrtle).
        check = address_side(line, street, side_raw)
        if check and check != sign:
            disagree.append(f"{row.main_id} {row.st_name} {side_raw}: ranges say {sign}, address points say {check}; using points")
            sign = check
    if sign:
        off = line.offset_curve(CURB_OFFSET_M * sign)
        if off.geom_type == "MultiLineString":
            off = linemerge(off)
        drawn = off if off.geom_type == "LineString" and not off.is_empty else line
    else:
        drawn = line

    # metered: active meters on this street within 15 m, on this side when known
    meters = [m for m in meters_by_street.get(street, []) if line.distance(m) < 15]
    if sign:
        meters = [m for m in meters if side_of(line, m) == sign]
    snow = any(n == street and line.buffer(10).intersection(sl).length > 0.5 * min(line.length, sl.length)
               for n, sl, _ in snow_lines) or any(
               n == street and sl.distance(line.interpolate(0.5, normalized=True)) < 10 for n, sl, _ in snow_lines)

    weeks = [i for i in range(1, 6) if row[f"week_{i}"] == "t"]
    days = [i for i, d in enumerate(["sunday", "monday", "tuesday", "wednesday",
                                     "thursday", "friday", "saturday"]) if row[d] == "t"]
    rows.append({
        "id": int(row.main_id),
        "street": DISPLAY.get(street, row.st_name),
        "side": side_raw,
        "sideKnown": bool(sign) or side_raw == "Both",
        "from": row["from"],
        "to": row.to,
        "start": row.start_time,
        "end": row.end_time,
        "weeks": weeks,
        "days": days,
        "yearRound": row.year_round == "t",
        "daily": len(days) == 7,
        "oneWay": row.one_way == "t",
        "lengthM": round(line.length),
        "metered": len(meters) >= 2,
        "snowArtery": bool(snow),
        "line": unproject(drawn.simplify(0.5).coords),
        "center": unproject([line.interpolate(0.5, normalized=True).coords[0]])[0],
        "sideDir": compass(line, drawn) if sign else "",
        "addr": curb_addresses(line, street, side_raw),
    })

# Same street, side, span and schedule appear twice in the source; keep one.
seen, unique = set(), []
for r in rows:
    k = (r["street"], r["side"], r["from"], r["to"], tuple(r["weeks"]), tuple(r["days"]), r["start"])
    if k not in seen:
        seen.add(k)
        unique.append(r)

snow_out = [{"name": n.title(), "line": [[round(x, 6), round(y, 6)] for x, y in part]}
            for n, _, part in snow_lines]
garages = []
for f in json.load(open(RAW / "snowparking.geojson"))["features"]:
    p = f["properties"]
    if "beacon hill" in str(p.get("Comments", "")).lower() or "all boston residents" in str(p.get("Comments", "")).lower():
        garages.append({"name": p["Name"], "address": p["Address"], "fee": p["Fee"],
                        "notes": p["Comments"], "lnglat": f["geometry"]["coordinates"]})

OUT.parent.mkdir(parents=True, exist_ok=True)
import datetime as _dt
src_ts = _dt.date.fromtimestamp((RAW / "sweeping.csv").stat().st_mtime).isoformat()
json.dump({"source": "City of Boston, Analyze Boston open data", "sourceUpdated": src_ts,
           "season": {"Beacon Hill": ["03-01", "12-31"]},
           "curbs": unique, "snowRoutes": snow_out, "snowGarages": garages},
          open(OUT, "w"), separators=(",", ":"))
# Same data as a script so the page also works opened straight from disk.
OUT.with_suffix(".js").write_text("window.BP_DATA=" + OUT.read_text() + ";\n")

print(f"{len(unique)} curbs written ({len(rows) - len(unique)} duplicates dropped), {len(problems)} unmatched")
for p in problems:
    print("  UNMATCHED", p)
for p in disagree:
    print("  SIDE CHECK", p)
for r in unique:
    flags = " ".join(f for f, on in (("METERED", r["metered"]), ("SNOW", r["snowArtery"]), ("DAILY", r["daily"]), ("NOSIDE", not r["sideKnown"])) if on)
    print(f"  {r['id']:>5} {r['street']:<18} {r['side']:<13} {r['from']:>17} -> {r['to']:<18} {r['lengthM']:>4}m {flags}")
