#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""meaicc shim: shrink reference-image data URLs, then forward to api.meaicc.com.

Why: the relay (sora plugin) inlines canvas reference images as data: URLs inside
input.media[].url — that is what meaicc accepts — but its bridge rejects the whole
request once the body gets too big (measured: 5.8 MB OK / 8.5 MB -> 请求格式错误2).
The canvas sends three 2.1 MB PNGs (6.4 MB), so the body lands at ~8.5 MB.

This shim sits in front of api.meaicc.com, logs the inbound body (same place the
capture proxy used), re-encodes oversized image data URLs down to a budget and
forwards. JSON in / JSON out; other methods and paths pass through untouched.

run:  python3 meaicc_shim.py [port]     (default 18889)
env:  SHIM_BUDGET_BYTES (default 4 MiB), SHIM_MAX_SIDE (1280), SHIM_QUALITY (82)
logs: /root/meaicc_shim/<ts>_<METHOD>_<path>.req / .resp, index meaicc_shim.log
"""
from __future__ import annotations

import base64
import http.client
import http.server
import io
import json
import os
import ssl
import sys
import time
import urllib.parse

from PIL import Image

UPSTREAM = os.environ.get("SHIM_UPSTREAM", "api.meaicc.com")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18889
BUDGET = int(os.environ.get("SHIM_BUDGET_BYTES", str(4 << 20)))
OUT_DIR = os.environ.get("SHIM_OUT_DIR", "/root/meaicc_shim")
INDEX = os.path.join(OUT_DIR, "meaicc_shim.log")
_CTX = ssl.create_default_context()

# 逐级降档：先按文档推荐的上限 1280/720p + q82，不够再往下压。
LADDER = [(int(os.environ.get("SHIM_MAX_SIDE", "1280")), int(os.environ.get("SHIM_QUALITY", "82"))),
          (1280, 72), (960, 72), (720, 65), (640, 60)]


def _read_body(handler: http.server.BaseHTTPRequestHandler) -> bytes:
    if (handler.headers.get("Transfer-Encoding") or "").lower() == "chunked":
        chunks = []
        while True:
            size_line = handler.rfile.readline().strip()
            if not size_line:
                break
            try:
                size = int(size_line.split(b";")[0], 16)
            except ValueError:
                break
            if size == 0:
                handler.rfile.readline()
                break
            chunks.append(handler.rfile.read(size))
            handler.rfile.readline()
        return b"".join(chunks)
    length = int(handler.headers.get("Content-Length") or 0)
    return handler.rfile.read(length) if length else b""


def _dataurl_payload(url: str):
    if not isinstance(url, str) or not url.startswith("data:"):
        return None
    head, _, payload = url.partition(",")
    if "base64" not in head:
        return None
    mime = head[5:].split(";")[0].strip().lower()
    try:
        return mime, base64.b64decode(payload)
    except Exception:  # noqa: BLE001
        return None


def _encode_image(raw: bytes, max_side: int, quality: int) -> bytes:
    image = Image.open(io.BytesIO(raw))
    if getattr(image, "is_animated", False):
        image.seek(0)
    image = image.convert("RGB")
    image.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    image.save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def shrink_document(doc: dict):
    """Re-encode image data URLs until the serialised body fits the budget."""
    media = ((doc.get("input") or {}).get("media")) if isinstance(doc.get("input"), dict) else None
    if not isinstance(media, list) or not media:
        return doc, "no-media"
    images = []  # (index, mime, raw)
    for index, item in enumerate(media):
        if not isinstance(item, dict):
            continue
        parsed = _dataurl_payload(item.get("url"))
        if parsed and parsed[0].startswith("image/"):
            images.append((index, parsed[0], parsed[1]))
    if not images:
        return doc, "no-inline-image"

    raw_total = sum(len(raw) for _, _, raw in images)
    current = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode()
    if len(current) <= BUDGET:
        return doc, "unchanged %d imgs %.2fMB" % (len(images), raw_total / 1e6)

    for max_side, quality in LADDER:
        candidate = json.loads(json.dumps(doc))
        cand_media = candidate["input"]["media"]
        ok = True
        for index, _mime, raw in images:
            try:
                shrunk = _encode_image(raw, max_side, quality)
            except Exception:  # noqa: BLE001
                ok = False
                break
            cand_media[index]["url"] = "data:image/jpeg;base64," + base64.b64encode(shrunk).decode()
        if not ok:
            continue
        encoded = json.dumps(candidate, separators=(",", ":"), ensure_ascii=False).encode()
        if len(encoded) <= BUDGET:
            return candidate, ("shrunk %d imgs %.2fMB -> %.2fMB @%dpx q%d"
                               % (len(images), raw_total / 1e6, len(encoded) / 1e6, max_side, quality))
    return doc, "budget-not-reachable"


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _proxy(self, method: str) -> None:
        body = _read_body(self)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        safe = urllib.parse.quote(self.path, safe="")[:80]
        base = os.path.join(OUT_DIR, "%s_%s_%s" % (stamp, method, safe))
        note = ""
        if method == "POST" and body:
            try:
                doc = json.loads(body.decode("utf-8"))
            except Exception:  # noqa: BLE001
                doc = None
            if isinstance(doc, dict):
                new_doc, note = shrink_document(doc)
                if note.startswith("shrunk") or note.startswith("budget"):
                    body = json.dumps(new_doc, separators=(",", ":"), ensure_ascii=False).encode()
        try:
            with open(base + ".req", "wb") as fh:
                fh.write(("%s %s %s\n" % (method, self.path, self.request_version)).encode())
                for key, value in self.headers.items():
                    fh.write(("%s: %s\n" % (key, value)).encode())
                fh.write(b"\n" + body)
            with open(INDEX, "a", encoding="utf-8") as fh:
                fh.write("%s %s %s clen=%d %s\n" % (stamp, method, self.path, len(body), note))
        except Exception:  # noqa: BLE001
            pass

        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ("host", "content-length", "connection", "transfer-encoding")}
        headers["Host"] = UPSTREAM
        headers["Content-Length"] = str(len(body))
        conn = http.client.HTTPSConnection(UPSTREAM, 443, timeout=180, context=_CTX)
        try:
            conn.request(method, self.path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            status, resp_headers = resp.status, resp.getheaders()
        except Exception as exc:  # noqa: BLE001
            data = ('{"error":"shim upstream failure: %s"}' % exc).encode()
            status, resp_headers = 502, [("Content-Type", "application/json")]
        try:
            with open(base + ".resp", "wb") as fh:
                fh.write(("%d\n" % status).encode())
                for key, value in resp_headers:
                    fh.write(("%s: %s\n" % (key, value)).encode())
                fh.write(b"\n" + data)
        except Exception:  # noqa: BLE001
            pass

        self.send_response(status)
        for key, value in resp_headers:
            # 只丢 hop-by-hop 头；Content-Encoding 必须保留（body 原样转发，
            # 剥掉编码头会让上游客户端把 gzip 字节当 JSON 解析）。
            if key.lower() in ("content-length", "transfer-encoding", "connection", "keep-alive", "teaser", "upgrade"):
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self._proxy("POST")

    def do_GET(self):
        self._proxy("GET")

    def do_PUT(self):
        self._proxy("PUT")

    def do_DELETE(self):
        self._proxy("DELETE")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("meaicc shim on 0.0.0.0:%d -> https://%s  budget=%.1fMB" % (PORT, UPSTREAM, BUDGET / 1e6), flush=True)
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


main()

