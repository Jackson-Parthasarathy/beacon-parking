"""Download City of Boston source data into tools/raw/ for build_data.py.

Run: python tools/fetch_raw.py
"""
import json
import urllib.parse
import urllib.error
import urllib.request
from pathlib import Path

RAW = Path(__file__).resolve().parent / "raw"
BBOX = "-71.0745,42.3530,-71.0580,42.3635"   # Beacon Hill plus a margin
SAM = "https://gisportal.boston.gov/arcgis/rest/services/SAM/Live_SAM_Address/FeatureServer"
SWEEPING_CSV = ("https://data.boston.gov/dataset/00c015a1-2b62-4072-a71e-79b292ce9670/resource/"
                "9fdbdcad-67c8-4b23-b6ec-861e77d56227/download/tmpgey6uwsd.csv")
LAYERS = {
    "segments": f"{SAM}/3/query",
    "addresses": f"{SAM}/0/query",
    "meters": "https://gisportal.boston.gov/arcgis/rest/services/Infrastructure/OpenData/MapServer/9/query",
    "snowroutes": "https://services.arcgis.com/sFnw0xNflSi8J0uh/arcgis/rest/services/Ownership/FeatureServer/0/query",
    "snowparking": "https://services.arcgis.com/sFnw0xNflSi8J0uh/arcgis/rest/services/SnowParking/FeatureServer/0/query",
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get(url):
    # The CSV redirects to a signed S3 URL written as host:443; the explicit
    # port ends up in the Host header and breaks the signature, so follow the
    # redirect by hand with the port dropped.
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(5):
        req = urllib.request.Request(url, headers={"User-Agent": "beacon-parking/1.0"})
        try:
            with opener.open(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (301, 302, 303, 307, 308):
                raise
            url = e.headers["Location"].replace(":443/", "/", 1)
    raise RuntimeError("too many redirects")


def query(url, bbox, fields="*"):
    feats, offset = [], 0
    while True:
        q = dict(where="1=1", geometry=bbox, geometryType="esriGeometryEnvelope", inSR=4326,
                 spatialRel="esriSpatialRelIntersects", outSR=4326, f="geojson",
                 outFields=fields, resultOffset=offset, resultRecordCount=2000)
        d = json.loads(get(url + "?" + urllib.parse.urlencode(q)))
        feats += d.get("features", [])
        more = d.get("exceededTransferLimit") or d.get("properties", {}).get("exceededTransferLimit")
        if not more:
            return feats
        offset += 2000


def main():
    RAW.mkdir(exist_ok=True)
    (RAW / "sweeping.csv").write_bytes(get(SWEEPING_CSV))
    for name, url in LAYERS.items():
        box = "-71.09,42.345,-71.05,42.37" if name == "snowparking" else BBOX
        fields = "FULL_STREET_NAME,STREET_NUMBER,SEGMENT_ID" if name == "addresses" else "*"
        feats = query(url, box, fields)
        json.dump({"type": "FeatureCollection", "features": feats}, open(RAW / f"{name}.geojson", "w"))
        print(f"{name}: {len(feats)} features")
    print("sweeping.csv:", sum(1 for _ in open(RAW / "sweeping.csv", encoding="utf-8")) - 1, "rows")


if __name__ == "__main__":
    main()
