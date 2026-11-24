"""ASGI wrapper that StudyOrbit puts in front of DeepTutor's API (decision #544).

DeepTutor 1.7.4 has no authentication by default, answers any Host and echoes any Origin in its CORS headers, and its
API can register stdio commands. Bound to loopback, it is still reachable from any web page open in the browser
(cross-site requests, DNS rebinding). This wrapper refuses, before DeepTutor sees them, HTTP requests and WebSocket
upgrades whose Host (or the Host that DeepTutor's web server forwards) is not a loopback name with an expected port, whose Origin (when present) is not an expected page
origin, or that the browser marks `Sec-Fetch-Site: cross-site`. Other programs running as the same user are not
stopped by this (they send whatever headers they like).

Run by `scripts/dev.mjs` with DeepTutor's own interpreter:
    python -m uvicorn guard_app:app --app-dir <this directory> --host 127.0.0.1 --port <api port>
Configuration (environment): STUDYORBIT_GUARD_PORTS (comma-separated ports accepted in Host) and
STUDYORBIT_GUARD_ORIGINS (comma-separated exact origins). `allowed()` is pure and is unit-tested from Node.
"""

from __future__ import annotations

import os
import sys

LOOPBACK_NAMES = ("localhost", "127.0.0.1", "[::1]")
FORWARDED_HOST_HEADERS = ("x-forwarded-host", "x-deeptutor-frontend-host")
CHECKED_HEADERS = ("host", "origin", "sec-fetch-site", *FORWARDED_HOST_HEADERS)


def _split(value: str) -> frozenset[str]:
    return frozenset(part.strip() for part in value.split(",") if part.strip())


def allowed_hosts(ports: frozenset[str]) -> frozenset[str]:
    return frozenset(f"{name}:{port}" for name in LOOPBACK_NAMES for port in ports)


def allowed(headers: dict[str, str], hosts: frozenset[str], origins: frozenset[str]) -> str | None:
    """The reason a request is refused, or None when it may pass. Header names are lower-case."""
    if headers.get("host", "") not in hosts:
        return "host"
    # DeepTutor's web server rewrites Host when it forwards to the API and puts the browser's Host in these two.
    for name in FORWARDED_HOST_HEADERS:
        if name in headers and headers[name] not in hosts:
            return "forwarded-host"
    origin = headers.get("origin")
    if origin is not None and origin not in origins:
        return "origin"
    if headers.get("sec-fetch-site", "").strip().lower() == "cross-site":
        return "cross-site"
    return None


def guard(inner, hosts: frozenset[str], origins: frozenset[str]):
    async def app(scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await inner(scope, receive, send)
            return
        headers: dict[str, str] = {}
        duplicated = False
        for raw_name, raw_value in scope.get("headers", []):
            name = raw_name.decode("latin-1").lower()
            if name in CHECKED_HEADERS:
                # Two values for one of these headers is never a browser's doing; refuse rather than pick one.
                duplicated = duplicated or name in headers
                headers[name] = raw_value.decode("latin-1")
        reason = "duplicate-header" if duplicated else allowed(headers, hosts, origins)
        if reason is None:
            await inner(scope, receive, send)
            return
        # The reason and the path only: header values and query strings are not logged.
        print(f"[studyorbit guard] refused {scope['type']} {scope.get('path', '')}: {reason}", file=sys.stderr, flush=True)
        if scope["type"] == "websocket":
            # Closing before accept makes the server answer the upgrade with 403.
            await send({"type": "websocket.close", "code": 1008})
            return
        await send({"type": "http.response.start", "status": 403, "headers": [(b"content-length", b"0")]})
        await send({"type": "http.response.body", "body": b""})

    return app


def _build():
    ports = _split(os.environ.get("STUDYORBIT_GUARD_PORTS", ""))
    origins = _split(os.environ.get("STUDYORBIT_GUARD_ORIGINS", ""))
    if not ports or not origins:
        raise RuntimeError("STUDYORBIT_GUARD_PORTS and STUDYORBIT_GUARD_ORIGINS must be set")
    from deeptutor.api.main import app as deeptutor_app

    return guard(deeptutor_app, allowed_hosts(ports), origins)


# Imported by the unit test with STUDYORBIT_GUARD_SKIP_APP=1, which only wants the pure functions.
app = None if os.environ.get("STUDYORBIT_GUARD_SKIP_APP") == "1" else _build()
