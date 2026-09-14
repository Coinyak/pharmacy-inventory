#!/usr/bin/env python3
"""Portable local server for the pharmacy inventory app.

Serves public/ and stores state in ../local-data so the folder can be copied
to another computer. Does not touch the Cloudflare deployment.

Usage (from the repo root):
  python3 local/server.py
  python3 local/server.py --import-cloud
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "local-data"
CLOUD_ORIGIN = "https://pharmacy-inventory-4pv.pages.dev"
TYPES = ("chemo", "general")
LOCK = threading.Lock()
HOST = "127.0.0.1"
DEFAULT_PORT = 8788


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def bump_time(base: str | None) -> str:
    now = now_iso()
    if base and now <= base:
        try:
            parsed = datetime.fromisoformat(base.replace("Z", "+00:00"))
            return (parsed + timedelta(milliseconds=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except ValueError:
            return now
    return now


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def state_path(data_type: str) -> Path:
    return DATA_DIR / f"{data_type}.json"


def stats_path() -> Path:
    return DATA_DIR / "stats.json"


def news_path() -> Path:
    return DATA_DIR / "news.json"


def empty_state() -> dict:
    return {"data": "{}", "daily_data": "{}", "updated_at": None}


def load_state(data_type: str) -> dict | None:
    row = read_json(state_path(data_type), None)
    if not isinstance(row, dict) or not row.get("updated_at"):
        return None
    return {
        "data": row.get("data") or "{}",
        "daily_data": row.get("daily_data") or "{}",
        "updated_at": row.get("updated_at"),
    }


def save_state(data_type: str, data: str, daily_data: str, updated_at: str) -> None:
    write_json(state_path(data_type), {
        "data": data or "{}",
        "daily_data": daily_data or "{}",
        "updated_at": updated_at,
    })


def load_stats() -> dict:
    raw = read_json(stats_path(), {})
    if not isinstance(raw, dict):
        return {"chemo": {}, "general": {}}
    return {
        "chemo": raw.get("chemo") if isinstance(raw.get("chemo"), dict) else {},
        "general": raw.get("general") if isinstance(raw.get("general"), dict) else {},
    }


def save_stats_batch(data_type: str, batch_text: str | None, updated_at: str) -> tuple[int, int]:
    if not batch_text:
        return 0, 0
    try:
        batch = json.loads(batch_text)
    except json.JSONDecodeError:
        return 0, 1
    if not isinstance(batch, list):
        return 0, 1
    saved = failed = 0
    with LOCK:
        store = load_stats()
        bucket = store.setdefault(data_type, {})
        for item in batch:
            if not isinstance(item, dict) or not item.get("date") or item.get("stats") is None:
                failed += 1
                continue
            bucket[item["date"]] = json.dumps(item["stats"], ensure_ascii=False, separators=(",", ":"))
            saved += 1
        write_json(stats_path(), store)
    return saved, failed


def stats_rows(data_type: str, start: str, end: str) -> list[dict]:
    bucket = load_stats().get(data_type) or {}
    rows = []
    for date in sorted(bucket):
        if start <= date <= end:
            rows.append({"date": date, "stats": bucket[date]})
    return rows


def admin_type(handler: BaseHTTPRequestHandler) -> str | None:
    auth = handler.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:].strip()
    kind = token if token in TYPES else token.split(":", 1)[0]
    return kind if kind in TYPES else None


def fetch_cloud(path: str, timeout: int = 40) -> bytes:
    req = urllib.request.Request(
        CLOUD_ORIGIN + path,
        headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    last_error = None
    for _ in range(2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code != 503:
                raise
    if last_error:
        raise last_error
    raise urllib.error.URLError("cloud fetch failed")


def import_cloud() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().date().isoformat()
    start = "2020-01-01"
    stats = load_stats()
    for data_type in TYPES:
        body = fetch_cloud(f"/api/state?type={data_type}")
        row = json.loads(body.decode("utf-8"))
        if row.get("updated_at") and row.get("data") and row.get("data") != "{}":
            write_json(state_path(data_type), {
                "data": row.get("data") or "{}",
                "daily_data": row.get("daily_data") or "{}",
                "updated_at": row.get("updated_at"),
            })
            print(f"imported {data_type} {row.get('updated_at')}")
        else:
            print(f"cloud {data_type} is empty; skipped")
        try:
            stats_body = fetch_cloud(
                f"/api/state?type={data_type}&stats_from={start}&stats_to={today}"
            )
            parsed = json.loads(stats_body.decode("utf-8"))
            bucket = {}
            for item in parsed.get("stats") or []:
                if item.get("date") and item.get("stats") is not None:
                    value = item["stats"]
                    bucket[item["date"]] = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            if bucket:
                stats[data_type] = bucket
                print(f"imported {data_type} stats {len(bucket)}")
        except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError) as exc:
            print(f"stats import skipped for {data_type}: {exc}")
    write_json(stats_path(), stats)
    try:
        news = fetch_cloud("/api/news")
        news_path().write_bytes(news)
        print("imported news cache")
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        print(f"news import skipped: {exc}")


def maybe_import_cloud() -> None:
    missing = [kind for kind in TYPES if not state_path(kind).exists()]
    if not missing:
        return
    print("local data missing; importing from the live server once")
    try:
        import_cloud()
    except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError) as exc:
        print(f"cloud import failed, starting empty: {exc}")


class Handler(BaseHTTPRequestHandler):
    server_version = "PharmacyLocal/1.0"

    def log_message(self, fmt: str, *args) -> None:
        if str(args[1:2] or "") in ("304",):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.handle_state_get(parse_qs(parsed.query))
            return
        if parsed.path == "/api/news":
            self.handle_news(refresh=False)
            return
        self.serve_static(parsed.path)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.handle_state_put()
            return
        self.send_error(404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/news":
            self.handle_news(refresh=True)
            return
        if parsed.path == "/api/auth":
            self.send_json({"ok": True})
            return
        self.send_error(404)

    def read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            value = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return {}
        return value if isinstance(value, dict) else {}

    def send_json(self, payload, status: int = 200, extra_headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def handle_state_get(self, query: dict) -> None:
        data_type = (query.get("type") or [None])[0]
        if data_type not in TYPES:
            self.send_json({"error": "type 파라미터 필요 (chemo|general)"}, 400)
            return
        start = (query.get("stats_from") or [None])[0]
        end = (query.get("stats_to") or [None])[0]
        if start and end:
            self.send_json({"stats": stats_rows(data_type, start, end)})
            return
        row = load_state(data_type)
        if not row:
            self.send_json(empty_state())
            return
        since = (query.get("since") or [None])[0]
        if since and since == row["updated_at"]:
            self.send_response(304)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_json(row)

    def handle_state_put(self) -> None:
        kind = admin_type(self)
        if not kind:
            self.send_json({"error": "인증 필요"}, 401)
            return
        body = self.read_body()
        data_type = body.get("type")
        if data_type not in TYPES:
            self.send_json({"error": "type 필요"}, 400)
            return
        if kind != data_type:
            self.send_json({"error": "다른 관리자의 데이터는 수정할 수 없습니다."}, 403)
            return
        data = body.get("data") or "{}"
        daily_data = body.get("daily_data") or "{}"
        if data != "{}":
            try:
                parsed = json.loads(data)
                if parsed.get("_dataType") and parsed.get("_dataType") != data_type:
                    self.send_json({"error": "데이터 타입 불일치"}, 400)
                    return
            except json.JSONDecodeError:
                pass
        with LOCK:
            current = load_state(data_type)
            base = body.get("base_updated_at")
            updated_at = bump_time(base if isinstance(base, str) else None)
            if current and not base:
                self.send_json({"error": "최신 데이터를 다시 불러온 뒤 저장하세요."}, 428)
                return
            if current and base != current["updated_at"]:
                self.send_json({
                    "error": "다른 사용자가 먼저 변경했습니다.",
                    "data": current["data"],
                    "daily_data": current["daily_data"],
                    "updated_at": current["updated_at"],
                }, 409)
                return
            save_state(data_type, data, daily_data, updated_at)
        saved, failed = save_stats_batch(data_type, body.get("daily_stats_batch"), updated_at)
        payload = {"success": True, "updated_at": updated_at}
        if saved or failed:
            payload["batch"] = {"saved": saved, "failed": failed}
        self.send_json(payload)

    def handle_news(self, refresh: bool) -> None:
        cached = read_json(news_path(), None)
        try:
            raw = fetch_cloud("/api/news")
            news_path().write_bytes(raw)
            payload = json.loads(raw.decode("utf-8"))
            if refresh:
                payload["refreshed"] = True
            self.send_json(payload)
        except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError) as exc:
            if isinstance(cached, dict):
                cached = dict(cached)
                cached["fromCache"] = True
                cached["error"] = str(exc)
                self.send_json(cached)
                return
            self.send_json({"items": [], "error": "뉴스는 서버가 켜져 있을 때만 가져옵니다."}, 200)

    def serve_static(self, raw_path: str) -> None:
        path = unquote(raw_path.split("?", 1)[0])
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/")
        target = (PUBLIC_DIR / rel).resolve()
        if PUBLIC_DIR not in target.parents and target != PUBLIC_DIR:
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime if mime.startswith("application/") or mime.startswith("image/") or mime.startswith("font/") else mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--import-cloud", action="store_true", help="copy the live server into local-data and exit")
    parser.add_argument("--no-import", action="store_true", help="do not fetch the live server when local-data is empty")
    args = parser.parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if args.import_cloud:
        try:
            import_cloud()
        except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError) as exc:
            print(f"cloud import failed: {exc}", flush=True)
            raise SystemExit(1)
        return
    if not args.no_import:
        maybe_import_cloud()
    port = args.port
    httpd = None
    for candidate in range(port, port + 10):
        try:
            httpd = ThreadingHTTPServer((HOST, candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit(f"no free port near {args.port}")
    print(f"local inventory: http://{HOST}:{port}/", flush=True)
    print(f"data folder: {DATA_DIR}", flush=True)
    print("copy this repo folder, including local-data, to the other computer and run the same command", flush=True)
    print("the Cloudflare site is unchanged", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
