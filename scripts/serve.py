#!/usr/bin/env python3
"""Preview server for the project page.

`python3 -m http.server` is not good enough here: it ignores `Range` and answers
every request with `200` and the whole file. Browsers use byte ranges to play
and seek video — Safari refuses to start playback at all without a `206`, and
seeking (which this page's explorer does on every scrub) is unreliable
everywhere else. GitHub Pages serves ranges correctly, so a page that looks
broken locally can be perfectly fine once deployed; this script removes that
false alarm.

Also speaks HTTP/1.1 with keep-alive, so the ~20 media files do not each pay for
a new connection.

    python3 scripts/serve.py [port] [--host HOST]

Binds every interface by default, so the page is reachable from other machines.
Note that this serves the whole project directory, including data/npz and
videos/ if they are present — pass --host 127.0.0.1 to keep it local.
"""
import argparse
import email.utils
import gzip
import io
import os
import re
import socket
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
CHUNK = 64 * 1024
GZIP_TYPES = (
    "text/", "application/javascript", "application/json", "image/svg+xml",
)
GZIP_MIN = 1024


class Server(ThreadingHTTPServer):
    # socketserver's default of 5 is small for a page that opens ~20 media
    # connections at once; a full backlog shows up as refused connections.
    request_queue_size = 64
    daemon_threads = True


class RangeHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    _gzip_response = False

    def end_headers(self):
        if not self._gzip_response:
            self.send_header("Accept-Ranges", "bytes")
        # no-cache, not no-store. Both make the browser check back on every
        # load, but no-store also forbids *keeping* the bytes — which turned
        # every srcset re-pick and every media re-attach into a fresh full
        # download, doubling the page's requests and bandwidth. no-cache still
        # shows edits immediately, via 304s.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _not_modified(self, path):
        """True if the client already has this file.

        SimpleHTTPRequestHandler does this for plain GETs, but the Range branch
        below bypasses it — and browsers always fetch media with Range, so
        without this check every reload re-downloaded every video in full.
        """
        ims = self.headers.get("If-Modified-Since")
        if not ims or self.headers.get("If-None-Match"):
            return False
        try:
            since = email.utils.parsedate_to_datetime(ims)
        except (TypeError, ValueError):
            return False
        if since.tzinfo is None:
            return False
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            return False
        return int(mtime) <= int(since.timestamp())

    def _send_304(self):
        self.send_response(304)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return None

    def send_head(self):
        self._gzip_response = False
        header = self.headers.get("Range")
        path = self.translate_path(self.path)

        if not header:
            if not os.path.isdir(path) and os.path.isfile(path):
                gz = self._gzipped(path)
                if gz is not None:
                    return gz
            return super().send_head()

        if os.path.isdir(path):
            return super().send_head()
        if self._not_modified(path):
            return self._send_304()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        m = RANGE_RE.match(header.strip())
        if not m or (not m.group(1) and not m.group(2)):
            f.close()
            self.send_error(400, "Malformed Range")
            return None

        if m.group(1):
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else size - 1
        else:                                   # suffix form: bytes=-N
            start = max(0, size - int(m.group(2)))
            end = size - 1
        end = min(end, size - 1)

        if start >= size or start > end:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        self._range = (start, end)
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(int(os.stat(path).st_mtime)))
        self.end_headers()
        return f

    def _gzipped(self, path):
        """Serve a compressible file gzipped, or return None to fall through.

        Only for whole-file requests: a Range names bytes of the encoded body,
        so compressing a partial response would be wrong.
        """
        if "gzip" not in self.headers.get("Accept-Encoding", ""):
            return None
        ctype = self.guess_type(path)
        if not ctype.startswith(GZIP_TYPES):
            return None
        try:
            st = os.stat(path)
            if st.st_size < GZIP_MIN:
                return None
            if self._not_modified(path):
                return self._send_304()
            with open(path, "rb") as fh:
                body = gzip.compress(fh.read(), 6)
        except OSError:
            return None
        self._gzip_response = True
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Last-Modified", self.date_time_string(int(st.st_mtime)))
        self.end_headers()
        return io.BytesIO(body)

    def copyfile(self, source, outputfile):
        rng = getattr(self, "_range", None)
        if rng is None:
            return super().copyfile(source, outputfile)
        self._range = None
        remaining = rng[1] - rng[0] + 1
        while remaining > 0:
            buf = source.read(min(CHUNK, remaining))
            if not buf:
                break
            outputfile.write(buf)
            remaining -= len(buf)


def local_ips():
    """Addresses this host is actually reachable at.

    getaddrinfo(gethostname()) is not enough — on a machine whose hostname maps
    to 127.0.1.1 it returns only loopback. Opening an unconnected UDP socket
    toward a public address makes the kernel pick the outbound interface, which
    is the address a viewer on the network would use.
    """
    ips = []
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))          # no packets are sent
        ips.append(s.getsockname()[0])
    except OSError:
        pass
    finally:
        s.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    return ips


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("port", nargs="?", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0",
                    help="bind address (default 0.0.0.0 = every interface; "
                         "use 127.0.0.1 to keep the page off the network)")
    args = ap.parse_args()

    handler = partial(RangeHandler, directory=str(ROOT))
    with Server((args.host, args.port), handler) as httpd:
        # flush: under nohup/pipes stdout is block-buffered, which would hide
        # the banner until the server is killed.
        lines = ["serving %s" % ROOT, "  http://localhost:%d/" % args.port]
        if args.host in ("0.0.0.0", "", "::"):
            lines += ["  http://%s:%d/" % (ip, args.port) for ip in local_ips()]
            lines.append("  (bound to every interface — anything that can reach "
                         "this host can read this directory)")
        lines.append("ctrl-c to stop")
        print("\n".join(lines), flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
