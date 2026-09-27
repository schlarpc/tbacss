#!/usr/bin/env python3
"""Serve the explorer with HTTP Range support.

The bundle is built around byte-range requests: `samples.bin` is a few hundred
megabytes and the page fetches ~30 KB of it at a time. Python's stock
`http.server` ignores `Range` and answers 200 with the whole file, which turns
every waveform click into a full download, so this adds the one feature that
matters.

    python3 scripts/serve.py            # http://127.0.0.1:8765
    python3 scripts/serve.py --port 9000 --directory web
"""

from __future__ import annotations

import argparse
import re
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO

_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class RangeHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler plus single-range `bytes=` support."""

    protocol_version = "HTTP/1.1"
    cache_data = False

    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        # No caching by default. This is a development server, and a cached
        # catalog.json quietly serves yesterday's data after a republish --
        # which looks exactly like the export being broken. Pass --cache to
        # exercise what a CDN would do.
        if self.cache_data and self.path.startswith("/data/"):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        header = self.headers.get("Range")
        if not header:
            return super().send_head()

        match = _RANGE.match(header.strip())
        if not match:
            return super().send_head()

        path = self.translate_path(self.path)
        if Path(path).is_dir():
            return super().send_head()
        try:
            # Handed to http.server, which closes it after copyfile().
            handle = open(path, "rb")  # noqa: SIM115
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        size = Path(path).stat().st_size
        first, last = match.group(1), match.group(2)
        if first:
            start = int(first)
            stop = int(last) if last else size - 1
        else:
            # bytes=-N means the final N bytes.
            start = max(0, size - int(last or 0))
            stop = size - 1
        stop = min(stop, size - 1)

        if start > stop or start >= size:
            handle.close()
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{stop}/{size}")
        self.send_header("Content-Length", str(stop - start + 1))
        self.end_headers()
        handle.seek(start)
        return _Window(handle, stop - start + 1)

    def log_message(self, fmt, *args):  # quieter than the default
        if "?" not in self.path:
            super().log_message(fmt, *args)


class _Window:
    """A read-only window onto part of a file, for copyfile()."""

    def __init__(self, handle: BinaryIO, remaining: int):
        self._handle = handle
        self._remaining = remaining

    def read(self, size=-1) -> bytes:
        if self._remaining <= 0:
            return b""
        if size is None or size < 0:
            size = self._remaining
        chunk = self._handle.read(min(size, self._remaining))
        self._remaining -= len(chunk)
        return chunk

    def close(self) -> None:
        self._handle.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--directory", default="web")
    parser.add_argument(
        "--cache", action="store_true", help="send long cache headers for /data, as a CDN would"
    )
    args = parser.parse_args()

    root = Path(args.directory).resolve()
    if not (root / "data" / "catalog.json").exists():
        print(f"warning: no bundle at {root / 'data'} — run `tbacss publish` first")

    RangeHandler.cache_data = args.cache
    handler = partial(RangeHandler, directory=str(root))
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"serving {root} at http://{args.bind}:{args.port}  (ranges enabled)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
