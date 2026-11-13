#!/usr/bin/env python3
"""Opt-in service checks through stock DuckDB 2.0.0 and signed VGI.

Run `make test-live LIVE_CASES=<JSON path>`. Datasets can change or become unavailable. Fixtures
in `make check` remain the deterministic correctness gate. A parent process
enforces the deadline and cleans up the worker process group on failure.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def load_cases(path: Path) -> list[dict]:
    manifest = json.loads(path.read_text())
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise ValueError("Live-test file must have schema_version 1")
    checks = manifest.get("checks")
    if not isinstance(checks, list) or not checks:
        raise ValueError("Live-test file must contain a nonempty checks array")
    for check in checks:
        if (not isinstance(check, dict)
                or not isinstance(check.get("name"), str) or not check["name"].strip()
                or not isinstance(check.get("sql"), str) or not check["sql"].strip()
                or not isinstance(check.get("rows"), list)
                or not all(isinstance(row, list) for row in check["rows"])):
            raise ValueError("Each check needs a name, SQL and expected rows as an array of arrays")
    return checks


def run_checks(cases: Path) -> dict:
    import duckdb

    checks = load_cases(cases)
    report = {"engine": "duckdb", "engine_version": duckdb.__version__,
              "cases": str(cases),
              "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(), "checks": []}
    with tempfile.TemporaryDirectory(prefix="arcgis-live-repositories-") as repo:
        con = duckdb.connect(config={"extension_repository_directory": repo})
        try:
            con.execute("SET allow_extension_repositories = 'allowed'")
            con.execute("CREATE EXTENSION REPOSITORY query_farm WITH PREFIX 'https://duckdb-extensions.query.farm'")
            con.execute("FORCE INSTALL vgi FROM query_farm; LOAD vgi FROM query_farm")
            con.execute("INSTALL spatial; LOAD spatial")
            report["extension_version"] = con.execute("SELECT extension_version FROM duckdb_extensions() WHERE extension_name='vgi'").fetchone()[0]
            worker = str(ROOT / "bin/vgi-arcgis-worker")
            attach = f"ATTACH 'arcgis' (TYPE vgi, LOCATION {sql_string(worker)})"
            con.execute(attach)
            report["attach_sql"] = attach
            for case in checks:
                name, sql, expected = case["name"], case["sql"], case["rows"]
                start = time.monotonic()
                check = {"name": name, "sql": sql}
                try:
                    rows = [list(row) for row in con.execute(sql).fetchall()]
                    check.update(rows=rows, expected=expected, status="passed" if rows == expected else "failed")
                except Exception as exc:
                    check.update(status="failed", error=str(exc))
                check["elapsed_seconds"] = round(time.monotonic() - start, 3)
                report["checks"].append(check)
                print(f"{check['status']}: {name} ({check['elapsed_seconds']}s)", file=sys.stderr, flush=True)
        finally:
            con.close()
    report["status"] = "passed" if all(c["status"] == "passed" for c in report["checks"]) else "failed"
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, required=True, help="JSON file containing SQL checks and expected rows")
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--output", type=Path, default=ROOT / ".tools/live.json")
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.child:
        try:
            report = run_checks(args.cases.resolve())
        except Exception as exc:
            report = {"status": "failed", "error": str(exc)}
        print(json.dumps(report, indent=2))
        return int(report["status"] != "passed")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                              "--cases", str(args.cases.resolve()), "--child"],
                             stdout=subprocess.PIPE, text=True, start_new_session=os.name != "nt")
    try:
        stdout, _ = child.communicate(timeout=args.timeout)
        report = json.loads(stdout)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            child.kill()
        else:
            os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        report = {"status": "failed", "error": f"Live checks exceeded {args.timeout} seconds"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"{report['status']}: report written to {args.output}")
    return int(report["status"] != "passed")


if __name__ == "__main__":
    raise SystemExit(main())
