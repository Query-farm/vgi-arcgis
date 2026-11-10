#!/usr/bin/env python3
"""A tiny, dependency-free mock of an ArcGIS Server REST endpoint, used by the tests.

The worker is tested against this server so the suite is deterministic and
runs offline. It implements just enough of the GeoServices REST API:

Directory
---------
``GET /arcgis/rest/services?f=json``                 folders + root services
``GET /arcgis/rest/services/<folder>?f=json``        services in a folder
``GET /arcgis/rest/services/<svc>/<Type>?f=json``    service: layers + tables
``GET /arcgis/rest/services/<svc>/<Type>/<id>?f=json``   layer metadata
``GET /arcgis/rest/services/<svc>/<Type>/<id>/query``    query

Services
--------
* ``Demo/Parcels`` FeatureServer (plus a MapServer twin the worker should skip):
  layer 0 ``Tax Parcels`` (polygons, GeoJSON + JSON), layer 1 ``Address
  Points`` (points, JSON only, so the worker must convert Esri JSON), table 2
  ``Owners`` (no geometry).
* ``Demo/Imagery`` ImageServer (not a feature service; skipped).
* ``3DEPIndex`` MapServer: "1 meter" under group "DEM Product Index" and
  "1 Meter" under group "Query" (duplicate names told apart by group).
* ``Secured`` FeatureServer that answers every request with error 499 "Token
  Required" (a subscriber-only service; listed with no views).
* ``Roads`` MapServer: layer 0 ``Road Centerlines`` (polylines) with no
  ``orderBy`` support but ``resultOffset`` paging.
* ``Legacy`` MapServer: layer 0 ``Old Points`` with neither ordering nor
  paging; a query that exceeds ``maxRecordCount`` cannot be paged.

Every layer has ``maxRecordCount`` 2, so any scan of more than two rows pages.

ArcGIS Hub
----------
Synthetic Hub and ArcGIS Online sharing APIs; point the worker at them with
``ARCGIS_HUB_API=<mock>`` and ``ARCGIS_PORTAL_API=<mock>/sharing/rest``. Item
URLs point back at this server (from the request's ``Host`` header).

``GET /api/v3/domains/<host>``                      site record, or HTTP 404
``GET /api/v3/datasets/<itemId>_<n>``               ``data.attributes.url``
``GET /sharing/rest/content/items/<id>[/data]``     item / site definition
``GET /sharing/rest/search?q=(group:..) AND (type:..)``  paged 3 at a time
``GET /sharing/rest/portals/<orgId>``               org ``urlKey``
``GET /api/search/v1/collections/all/items?q=..``   site search (GeoJSON)

Sites: ``127.0.0.1`` (``catalogV2`` groups g1, g2) and
``legacy-hub.example.org`` (old ``catalog.groups``: g3). See ``HUB_ITEMS``.

Query parameters honoured: ``where`` (a small SQL subset: comparisons, IN,
IS [NOT] NULL, LIKE, AND/OR/NOT, parentheses), ``outFields``,
``returnGeometry``, ``geometryPrecision``, ``orderByFields`` (object id
ascending), ``resultOffset``, ``resultRecordCount``, ``returnCountOnly``,
``f`` = ``json`` | ``geojson``. ``outSR`` is accepted and ignored: the data is
stored in WGS84 already.

Test hooks
----------
* ``MOCK_API_FLAKY=1``: the first request for each distinct query URL gets a
  ``429`` with ``Retry-After: 0``, exercising the client's retry path.
* ``GET /_log``: the ``where`` clauses received, most recent last.
* ``GET /health``: ``{"status": "ok"}``.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MAX_RECORDS = 2
DAY_MS = 86_400_000

PARCEL_FIELDS = [
    {"name": "OBJECTID", "type": "esriFieldTypeOID"},
    {"name": "PARCEL_ID", "type": "esriFieldTypeString"},
    {"name": "FIPS", "type": "esriFieldTypeString"},
    {"name": "ACRES", "type": "esriFieldTypeDouble"},
    {"name": "YEAR_BUILT", "type": "esriFieldTypeInteger"},
    {"name": "FLOORS", "type": "esriFieldTypeSmallInteger"},
    {"name": "UPDATED", "type": "esriFieldTypeDate"},
    {"name": "Shape", "type": "esriFieldTypeGeometry"},
]

# Polygons as GeoJSON-style coordinates: a list of polygons, each a list of
# rings (outer first). The Esri form is derived with Esri ring orientation.
PARCELS = [
    (1, "A-1", "51001", 1.5, 1990, 1, 10, [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]]),
    (2, "A-2", "51001", 2.25, 2005, 2, 20, [[[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]]),
    (3, "B-1", "51003", None, None, None, None, [[[[0, 2], [3, 2], [3, 5], [0, 5], [0, 2]],
                                                  [[1, 3], [1, 4], [2, 4], [2, 3], [1, 3]]]]),
    (4, "B-2", "51003", 10.0, 1975, 3, 30, [[[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
                                             [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]]]),
    (5, "C'1", "51005", 0.123456789, 2021, 1, 40, [[[[-77.123456789, 37.987654321], [-77.1, 37.98],
                                                    [-77.1, 38.0], [-77.123456789, 37.987654321]]]]),
]

POINT_FIELDS = [
    {"name": "OBJECTID", "type": "esriFieldTypeOID"},
    {"name": "ADDRESS", "type": "esriFieldTypeString"},
    {"name": "ZIP", "type": "esriFieldTypeString"},
]
POINTS = [(1, "1 Main St", "22901", (-78.5, 38.03)), (2, "2 Oak Ave", "22902", (-78.49, 38.02)),
          (3, "3 Elm Rd", "22901", (-78.48, 38.01))]

OWNER_FIELDS = [
    {"name": "OBJECTID", "type": "esriFieldTypeOID"},
    {"name": "PARCEL_ID", "type": "esriFieldTypeString"},
    {"name": "OWNER", "type": "esriFieldTypeString"},
]
OWNERS = [(1, "A-1", "Smith"), (2, "A-2", "Jones"), (3, "B-1", None)]

ROAD_FIELDS = [
    {"name": "OBJECTID", "type": "esriFieldTypeOID"},
    {"name": "NAME", "type": "esriFieldTypeString"},
    {"name": "SPEED", "type": "esriFieldTypeInteger"},
]
ROADS = [(1, "Main St", 25, [[[0, 0], [1, 1]]]), (2, "Route 29", 55, [[[0, 0], [0, 5]], [[0, 6], [0, 9]]]),
         (3, "Oak Ave", 25, [[[2, 2], [3, 3], [4, 3]]])]

LEGACY_FIELDS = [{"name": "OBJECTID", "type": "esriFieldTypeOID"}, {"name": "KIND", "type": "esriFieldTypeString"}]
LEGACY = [(1, "a", (0, 0)), (2, "b", (1, 1)), (3, "b", (2, 2))]


def _signed_area(ring: list) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))


def _esri_rings(polygons: list) -> list:
    """Esri polygons: outer rings clockwise, holes counter-clockwise."""
    rings = []
    for poly in polygons:
        for i, ring in enumerate(poly):
            clockwise = _signed_area(ring) < 0
            want_clockwise = i == 0
            rings.append(ring if clockwise == want_clockwise else list(reversed(ring)))
    return rings


def _rows(fields: list, values: list) -> list:
    names = [f["name"] for f in fields if f["type"] != "esriFieldTypeGeometry"]
    return [dict(zip(names, v)) for v in values]


def _layer(lid, name, kind, fields, geometry_type, formats, order_by=True, pagination=True, parent=-1):
    return {
        "id": lid,
        "name": name,
        "type": kind,
        "parentLayerId": parent,
        "geometryType": geometry_type,
        "objectIdField": "OBJECTID",
        "fields": fields,
        "maxRecordCount": MAX_RECORDS,
        "supportedQueryFormats": formats,
        "advancedQueryCapabilities": {"supportsOrderBy": order_by, "supportsPagination": pagination},
        "capabilities": "Query",
    }


def _parcel_features():
    out = []
    for oid, pid, fips, acres, year, floors, upd, polys in PARCELS:
        attrs = {"OBJECTID": oid, "PARCEL_ID": pid, "FIPS": fips, "ACRES": acres, "YEAR_BUILT": year,
                 "FLOORS": floors, "UPDATED": None if upd is None else upd * DAY_MS}
        gj = {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else \
             {"type": "MultiPolygon", "coordinates": polys}
        out.append((attrs, {"rings": _esri_rings(polys)}, gj))
    return out


def _point_features(rows):
    return [({"OBJECTID": r[0], "ADDRESS": r[1], "ZIP": r[2]}, {"x": r[3][0], "y": r[3][1]},
             {"type": "Point", "coordinates": list(r[3])}) for r in rows]


def _road_features():
    out = []
    for oid, name, speed, paths in ROADS:
        gj = {"type": "LineString", "coordinates": paths[0]} if len(paths) == 1 else \
             {"type": "MultiLineString", "coordinates": paths}
        out.append(({"OBJECTID": oid, "NAME": name, "SPEED": speed}, {"paths": paths}, gj))
    return out


GJ = ["JSON", "geoJSON"]
SERVICES = {
    ("Demo/Parcels", "FeatureServer"): {
        "layers": {0: (_layer(0, "Tax Parcels", "Feature Layer", PARCEL_FIELDS, "esriGeometryPolygon",
                              ",".join(GJ)), _parcel_features()),
                   1: (_layer(1, "Address Points", "Feature Layer", POINT_FIELDS, "esriGeometryPoint", "JSON"),
                       _point_features(POINTS))},
        "tables": {2: (_layer(2, "Owners", "Table", OWNER_FIELDS, None, ",".join(GJ)),
                       [(r, None, None) for r in _rows(OWNER_FIELDS, OWNERS)])},
    },
    ("Roads", "MapServer"): {
        "layers": {0: (_layer(0, "Road Centerlines", "Feature Layer", ROAD_FIELDS, "esriGeometryPolyline",
                              ",".join(GJ), order_by=False, pagination=True), _road_features())},
        "tables": {},
    },
    ("Legacy", "MapServer"): {
        "layers": {0: (_layer(0, "Old Points", "Feature Layer", LEGACY_FIELDS, "esriGeometryPoint", "JSON",
                              order_by=False, pagination=False),
                       [({"OBJECTID": o, "KIND": k}, {"x": p[0], "y": p[1]}, None) for o, k, p in LEGACY])},
        "tables": {},
    },
}
# Directory listing extras the worker must skip or de-duplicate.
DIRECTORY = {
    "": {"folders": ["Demo"], "services": [{"name": "Roads", "type": "MapServer"},
                                           {"name": "Legacy", "type": "MapServer"},
                                           {"name": "Secured", "type": "FeatureServer"},
                                           {"name": "Geocoder", "type": "GeocodeServer"}]},
    "Demo": {"folders": [], "services": [{"name": "Demo/Parcels", "type": "FeatureServer"},
                                         {"name": "Demo/Parcels", "type": "MapServer"},
                                         {"name": "Demo/Imagery", "type": "ImageServer"}]},
}
SERVICES[("Demo/Parcels", "MapServer")] = SERVICES[("Demo/Parcels", "FeatureServer")]


def _group(lid, name):
    return (_layer(lid, name, "Group Layer", [], None, "JSON"), [])


def _legacy_points(lid, name, parent):
    return (_layer(lid, name, "Feature Layer", LEGACY_FIELDS, "esriGeometryPoint", "JSON", parent=parent),
            [({"OBJECTID": o, "KIND": k}, {"x": p[0], "y": p[1]}, None) for o, k, p in LEGACY])


# Like USGS 3DEPElevationIndex: one layer repeated under two group layers,
# names that need CamelCase splitting and a leading-digit fix.
SERVICES[("3DEPIndex", "MapServer")] = {
    "layers": {0: _group(0, "DEM Product Index"),
               1: _legacy_points(1, "1 meter", 0),
               2: _group(2, "Query"),
               3: _legacy_points(3, "1 Meter", 2),
               4: _legacy_points(4, "Coverage", 2)},
    "tables": {},
}
DIRECTORY[""]["services"].append({"name": "3DEPIndex", "type": "MapServer"})

# ---------------------------------------------------------------- ArcGIS Hub

HUB_SITES = {
    "127.0.0.1": {"siteId": "a0000000000000000000000000000001", "siteTitle": "Mock Open Data", "orgKey": "MOCKORG",
                  "orgId": "mockOrgA",
                  "data": {"catalogV2": {"schemaVersion": 1, "scopes": {"item": {"targetEntity": "item", "filters": [
                      {"predicates": [{"group": {"any": ["g1", "g2"]}}]}]}}}}},
    "legacy-hub.example.org": {"siteId": "a0000000000000000000000000000002", "siteTitle": "Legacy Hub",
                               "orgKey": "MOCKORG", "orgId": "mockOrgA",
                               "data": {"catalog": {"groups": ["g3"]}}},
}
HUB_PORTALS = {"mockOrgA": "MOCKORG", "mockOrgB": "MOCKB"}
_R = "/arcgis/rest/services"
# (id, title, type, url path or None, owner, orgId, groups, snippet)
HUB_ITEMS = [
    ("1" * 32, "Tax Parcels", "Feature Service", f"{_R}/Demo/Parcels/FeatureServer", "mockcounty", "mockOrgA",
     ["g1", "g3"], "Parcel polygons, owners and <b>address points</b>"),
    # The MapServer twin of the item above: listed once, as the FeatureServer.
    ("2" * 32, "Tax Parcels (map)", "Map Service", f"{_R}/Demo/Parcels/MapServer", "mockcounty", "mockOrgA",
     ["g2"], None),
    ("3" * 32, "Road Centerlines", "Feature Service", f"{_R}/Roads/MapServer/0", "mockcounty", "mockOrgA",
     ["g1", "g3"], "One layer item"),
    ("4" * 32, "Secured Data", "Feature Service", f"{_R}/Secured/FeatureServer", "mockcounty", "mockOrgA",
     ["g2"], None),
    ("5" * 32, "Zoning", "Map Service", f"{_R}/Legacy/MapServer", "county_a", "mockOrgA", ["g1"], None),
    ("6" * 32, "Zoning", "Map Service", f"{_R}/3DEPIndex/MapServer", "county_b", "mockOrgB", ["g2"], None),
    ("7" * 32, "Broken Link", "Feature Service", None, "mockcounty", "mockOrgA", ["g1"], None),
    ("8" * 32, "Hydrants", "Feature Service", f"{_R}/Legacy/MapServer/0", "mockcounty", "mockOrgA", ["g1"], None),
    ("9" * 32, "Hydrants", "Feature Service", f"{_R}/Demo/Parcels/FeatureServer/1", "mockcounty", "mockOrgA",
     ["g2"], None),
    ("a" * 32, "Parcel Story", "StoryMap", None, "mockcounty", "mockOrgA", ["g1"], None),
]
HUB_PAGE = 3


def _hub_item(row, base: str) -> dict:
    iid, title, kind, path, owner, org, _groups, snippet = row
    return {"id": iid, "title": title, "type": kind, "url": f"{base}{path}" if path else None, "owner": owner,
            "orgId": org, "snippet": snippet, "access": "public"}


# ---------------------------------------------------------------- where parser

TOKEN = re.compile(r"\s*(?:(?P<num>-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|(?P<str>'(?:[^']|'')*')|"
                   r"(?P<op><>|<=|>=|=|<|>|\(|\)|,)|(?P<word>[A-Za-z_][A-Za-z0-9_]*))")


class WhereError(ValueError):
    pass


def tokenize(text: str) -> list:
    pos, out = 0, []
    text = text.strip()
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m or m.end() == pos:
            raise WhereError(f"bad token at {text[pos:pos + 20]!r}")
        pos = m.end()
        if m.group("num") is not None:
            out.append(("val", float(m.group("num")) if re.search(r"[.eE]", m.group("num")) else int(m.group("num"))))
        elif m.group("str") is not None:
            out.append(("val", m.group("str")[1:-1].replace("''", "'")))
        elif m.group("op") is not None:
            out.append(("op", m.group("op")))
        else:
            word = m.group("word")
            kw = word.upper()
            out.append(("kw", kw) if kw in {"AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE"} else ("id", word))
    return out


class Parser:
    def __init__(self, tokens):
        self.t, self.i = tokens, 0

    def peek(self, kind=None, value=None):
        if self.i >= len(self.t):
            return None
        tok = self.t[self.i]
        if (kind and tok[0] != kind) or (value is not None and tok[1] != value):
            return None
        return tok

    def take(self, kind=None, value=None):
        tok = self.peek(kind, value)
        if tok is None:
            raise WhereError(f"expected {kind} {value} at token {self.i}")
        self.i += 1
        return tok

    def parse(self):
        node = self.or_()
        if self.i != len(self.t):
            raise WhereError(f"trailing tokens at {self.i}")
        return node

    def or_(self):
        node = self.and_()
        while self.peek("kw", "OR"):
            self.take()
            node = ("or", node, self.and_())
        return node

    def and_(self):
        node = self.not_()
        while self.peek("kw", "AND"):
            self.take()
            node = ("and", node, self.not_())
        return node

    def not_(self):
        if self.peek("kw", "NOT"):
            self.take()
            return ("not", self.not_())
        return self.pred()

    def operand(self):
        tok = self.take()
        if tok[0] == "id":
            return ("col", tok[1])
        if tok[0] == "val":
            return ("val", tok[1])
        raise WhereError(f"unexpected {tok}")

    def pred(self):
        if self.peek("op", "("):
            self.take()
            node = self.or_()
            self.take("op", ")")
            return node
        left = self.operand()
        negated = bool(self.peek("kw", "NOT")) and self.take() is not None
        if self.peek("kw", "IN"):
            self.take()
            self.take("op", "(")
            values = [self.take("val")[1]]
            while self.peek("op", ","):
                self.take()
                values.append(self.take("val")[1])
            self.take("op", ")")
            return ("in", left, values, negated)
        if self.peek("kw", "LIKE"):
            self.take()
            return ("like", left, self.take("val")[1], negated)
        if negated:
            raise WhereError("NOT must precede IN or LIKE here")
        if self.peek("kw", "IS"):
            self.take()
            neg = bool(self.peek("kw", "NOT")) and self.take() is not None
            self.take("kw", "NULL")
            return ("isnull", left, neg)
        op = self.take("op")[1]
        return ("cmp", op, left, self.operand())


def evaluate(node, row) -> bool | None:
    kind = node[0]
    if kind == "and":
        a, b = evaluate(node[1], row), evaluate(node[2], row)
        return False if a is False or b is False else (None if a is None or b is None else True)
    if kind == "or":
        a, b = evaluate(node[1], row), evaluate(node[2], row)
        return True if a is True or b is True else (None if a is None or b is None else False)
    if kind == "not":
        v = evaluate(node[1], row)
        return None if v is None else not v

    def value(operand):
        if operand[0] == "val":
            return operand[1]
        if operand[1] not in row:
            raise WhereError(f"unknown field {operand[1]}")
        return row[operand[1]]

    if kind == "isnull":
        v = value(node[1]) is None
        return not v if node[2] else v
    if kind == "in":
        v = value(node[1])
        if v is None:
            return None
        hit = v in node[2]
        return not hit if node[3] else hit
    if kind == "like":
        v = value(node[1])
        if v is None:
            return None
        pattern = "^" + "".join(".*" if c == "%" else "." if c == "_" else re.escape(c) for c in node[2]) + "$"
        hit = re.match(pattern, v, re.DOTALL) is not None
        return not hit if node[3] else hit
    op, a, b = node[1], value(node[2]), value(node[3])
    if a is None or b is None:
        return None
    return {"=": a == b, "<>": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


def matches(where: str, row: dict) -> bool:
    return evaluate(Parser(tokenize(where)).parse(), row) is True


# ---------------------------------------------------------------- HTTP

_flaky_seen: set[str] = set()
_lock = threading.Lock()
WHERE_LOG: list[str] = []


def _round(obj, digits):
    if isinstance(obj, float):
        return round(obj, digits)
    if isinstance(obj, list):
        return [_round(v, digits) for v in obj]
    if isinstance(obj, dict):
        return {k: _round(v, digits) for k, v in obj.items()}
    return obj


class Handler(BaseHTTPRequestHandler):
    """Serve the mock ArcGIS REST API."""

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        """Log to stderr only, so stdout carries nothing except the ``PORT:`` line."""
        sys.stderr.write("mock_arcgis: " + (format % args) + "\n")

    def _send(self, status: int, body: object, headers: dict[str, str] | None = None) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, message: str, code: int = 400) -> None:
        # ArcGIS reports errors with HTTP 200 and an error object.
        self._send(200, {"error": {"code": code, "message": message, "details": []}})

    def do_GET(self) -> None:  # noqa: C901, PLR0911, PLR0912 - one small router
        """Route a GET request."""
        url = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(url.query).items()}
        if url.path == "/health":
            self._send(200, {"status": "ok"})
            return
        if url.path == "/_log":
            with _lock:
                self._send(200, {"where": list(WHERE_LOG)})
            return
        if os.environ.get("MOCK_API_FLAKY") == "1":
            with _lock:
                if self.path not in _flaky_seen:
                    _flaky_seen.add(self.path)
                    self._send(429, {"error": "slow down"}, {"Retry-After": "0"})
                    return
        if url.path.startswith(("/api/", "/sharing/rest/")):
            self._hub(url.path, q)
            return
        prefix = "/arcgis/rest/services"
        if not url.path.startswith(prefix):
            self._send(404, {"error": "not found"})
            return
        rest = url.path[len(prefix):].strip("/")
        if rest in DIRECTORY:
            self._send(200, {"currentVersion": 11.3, **DIRECTORY[rest]})
            return
        if rest.startswith("Secured/"):
            # A subscriber-only service: ArcGIS answers 499 without a token.
            self._error("Token Required", 499)
            return
        m = re.fullmatch(r"(.+)/(FeatureServer|MapServer)(?:/(\d+))?(/query)?", rest)
        if not m or (m.group(1), m.group(2)) not in SERVICES:
            self._error("Service not found", 404)
            return
        svc = SERVICES[(m.group(1), m.group(2))]
        if m.group(3) is None:
            self._send(200, {
                "currentVersion": 11.3,
                "serviceDescription": f"Mock {m.group(1)}",
                "maxRecordCount": MAX_RECORDS,
                "layers": [{"id": i, "name": meta["name"], "type": meta["type"],
                            "geometryType": meta["geometryType"], "parentLayerId": meta["parentLayerId"]}
                           for i, (meta, _) in svc["layers"].items()],
                "tables": [{"id": i, "name": meta["name"], "type": "Table"} for i, (meta, _) in svc["tables"].items()],
            })
            return
        lid = int(m.group(3))
        entry = svc["layers"].get(lid) or svc["tables"].get(lid)
        if entry is None:
            self._error("Invalid layer", 400)
            return
        meta, features = entry
        if not m.group(4):
            self._send(200, {"currentVersion": 11.3, **meta})
            return
        self._query(meta, features, q)

    def _hub(self, path: str, q: dict) -> None:  # noqa: C901, PLR0911, PLR0912 - one small router
        base = f"http://{self.headers.get('Host', '127.0.0.1')}"
        items = {row[0]: row for row in HUB_ITEMS}
        if m := re.fullmatch(r"/api/v3/domains/([^/]+)", path):
            site = HUB_SITES.get(m.group(1))
            if site is None:
                self._send(404, {"status": 404, "error": {"title": "Domain record(s) not found"}})
                return
            self._send(200, {"hostname": m.group(1), **{k: v for k, v in site.items() if k != "data"}})
            return
        if m := re.fullmatch(r"/api/v3/datasets/([0-9a-f]{32})_(\d+)", path):
            row = items.get(m.group(1))
            if row is None or row[3] is None:
                self._send(404, {"errors": [{"title": "Resource Not Found", "status": 404}]})
                return
            url = f"{base}{row[3]}"
            if not re.search(r"/\d+$", url):
                url = f"{url}/{m.group(2)}"
            self._send(200, {"data": {"id": f"{row[0]}_{m.group(2)}", "type": "dataset",
                                      "attributes": {"name": row[1], "url": url}}})
            return
        if m := re.fullmatch(r"/sharing/rest/content/items/([0-9a-f]{32})(/data)?", path):
            if m.group(2):
                site = next((s for s in HUB_SITES.values() if s["siteId"] == m.group(1)), None)
                if site is None:
                    self._error("Item does not exist or is inaccessible.", 400)
                    return
                self._send(200, site["data"])
                return
            row = items.get(m.group(1))
            if row is None:
                self._error("Item does not exist or is inaccessible.", 400)
                return
            self._send(200, _hub_item(row, base))
            return
        if m := re.fullmatch(r"/sharing/rest/portals/([^/]+)", path):
            if m.group(1) not in HUB_PORTALS:
                self._error("Invalid portal", 400)
                return
            self._send(200, {"id": m.group(1), "urlKey": HUB_PORTALS[m.group(1)]})
            return
        if path == "/sharing/rest/search":
            text = q.get("q", "")
            groups = set(re.findall(r"group:(\w+)", text))
            types = set(re.findall(r'type:"([^"]+)"', text))
            hits = [r for r in sorted(HUB_ITEMS) if groups & set(r[6]) and (not types or r[2] in types)]
            start = int(q.get("start", "1"))
            num = min(int(q.get("num", "10")), HUB_PAGE)
            page = hits[start - 1:start - 1 + num]
            nxt = start + len(page) if start - 1 + num < len(hits) else -1
            self._send(200, {"total": len(hits), "start": start, "num": num, "nextStart": nxt,
                             "results": [_hub_item(r, base) for r in page]})
            return
        if path == "/api/search/v1/collections/all/items":
            words = [w for w in re.split(r"\W+", q.get("q", "").lower()) if w]
            hits = [r for r in HUB_ITEMS if all(w in r[1].lower() for w in words)]
            features = [{"type": "Feature", "id": r[0], "geometry": None,
                         "properties": {k: v for k, v in _hub_item(r, base).items() if k != "orgId"}}
                        for r in hits[:int(q.get("limit", "10"))]]
            self._send(200, {"type": "FeatureCollection", "features": features, "numberMatched": len(hits),
                             "numberReturned": len(features)})
            return
        self._send(404, {"error": "not found"})

    def _query(self, meta: dict, features: list, q: dict) -> None:  # noqa: C901, PLR0912
        fmt = q.get("f", "html").lower()
        formats = meta["supportedQueryFormats"].lower().split(",")
        if fmt == "geojson" and "geojson" not in formats:
            self._error("Requested operation is not supported by this service. f=geojson", 400)
            return
        if fmt not in ("json", "pjson", "geojson"):
            self._error(f"unsupported f={fmt}")
            return
        where = q.get("where", "1=1")
        with _lock:
            WHERE_LOG.append(where)
            del WHERE_LOG[:-200]
        try:
            rows = [f for f in features if matches(where, f[0])]
        except WhereError as err:
            self._error(f"Unable to complete operation. {err}")
            return
        if q.get("returnCountOnly", "false").lower() == "true":
            self._send(200, {"count": len(rows)})
            return
        order = q.get("orderByFields")
        adv = meta["advancedQueryCapabilities"]
        if order:
            if not adv["supportsOrderBy"]:
                self._error("orderByFields is not supported")
                return
            rows.sort(key=lambda f: f[0]["OBJECTID"])
        offset = int(q.get("resultOffset", "0"))
        if ("resultOffset" in q or "resultRecordCount" in q) and not adv["supportsPagination"]:
            self._error("Pagination is not supported")
            return
        limit = min(int(q.get("resultRecordCount", MAX_RECORDS)), MAX_RECORDS)
        page = rows[offset:offset + limit]
        exceeded = offset + limit < len(rows)
        out_fields = q.get("outFields", "*")
        names = [f["name"] for f in meta["fields"] if f["type"] != "esriFieldTypeGeometry"]
        keep = names if out_fields.strip() == "*" else [n.strip() for n in out_fields.split(",")]
        for n in keep:
            if n not in names:
                self._error(f"Invalid field: {n}")
                return
        with_geom = meta["geometryType"] is not None and q.get("returnGeometry", "true").lower() == "true"
        digits = int(q["geometryPrecision"]) if "geometryPrecision" in q else None
        out = []
        for attrs, esri, gj in page:
            props = {n: attrs.get(n) for n in keep}
            geom = (gj if fmt == "geojson" else esri) if with_geom else None
            if geom is not None and digits is not None:
                geom = _round(json.loads(json.dumps(geom), parse_int=float), digits)
            if fmt == "geojson":
                out.append({"type": "Feature", "id": attrs["OBJECTID"], "geometry": geom, "properties": props})
            else:
                out.append({"attributes": props, **({"geometry": geom} if with_geom else {})})
        if fmt == "geojson":
            body = {"type": "FeatureCollection", "features": out}
            if exceeded:
                body["properties"] = {"exceededTransferLimit": True}
        else:
            body = {"objectIdFieldName": "OBJECTID", "geometryType": meta["geometryType"],
                    "fields": [f for f in meta["fields"] if f["name"] in keep], "features": out}
            if exceeded:
                body["exceededTransferLimit"] = True
        self._send(200, body)


def main() -> None:
    """Start the server and print ``PORT:<n>`` once it is listening."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"PORT:{server.server_address[1]}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
