"""ASGI wrapper that StudyOrbit puts in front of DeepTutor's API (decision #544).

DeepTutor 1.7.4 has no authentication by default, answers any Host and echoes any Origin in its CORS headers, and its
API can register stdio commands. Bound to loopback, it is still reachable from any web page open in the browser
(cross-site requests, DNS rebinding). This wrapper refuses, before DeepTutor sees them, HTTP requests and WebSocket
upgrades whose Host (or the Host that DeepTutor's web server forwards) is not a loopback name with an expected port, whose Origin (when present) is not an expected page
origin, or that the browser marks `Sec-Fetch-Site: cross-site`. Other programs running as the same user are not
stopped by this (they send whatever headers they like).

It also answers two things itself: `/studyorbit-guard/instance` (which checkout this DeepTutor belongs to) and, only
when DeepTutor has no such route, an empty knowledge-base list (see `KB_LIST_PATH` below).

Run by the local API server with DeepTutor's own interpreter:
    python -m uvicorn guard_app:app --app-dir <this directory> --host 127.0.0.1 --port <api port>
Configuration (environment): STUDYORBIT_GUARD_PORTS (comma-separated ports accepted in Host),
STUDYORBIT_GUARD_ORIGINS (comma-separated exact origins) and STUDYORBIT_GUARD_INSTANCE (the id of the checkout that
started it, answered at /studyorbit-guard/instance). `allowed()` is pure and is unit-tested from Node.
"""

from __future__ import annotations

import json
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


INSTANCE_PATH = "/studyorbit-guard/instance"


KB_LIST_PATH = "/api/knowledge-bases/list"


def route_state(app, path: str, method: str = "GET") -> str:
    """Whether the wrapped application routes `path`: "present", "absent" or "unknown".

    Asked the way Starlette itself decides, through each top-level route's public `matches(scope)` (which also covers
    routers included by FastAPI): no route matching means the application would answer 404, so "absent". The answer is
    "unknown", never "absent", whenever that cannot be established: no readable route table, a route that cannot be
    asked, or a match by a mount or host route, which only says that something below a prefix may handle the path.
    """
    routes = getattr(app, "routes", None)
    if not isinstance(routes, (list, tuple)):
        return "unknown"
    scope = {"type": "http", "path": path, "method": method, "root_path": "", "query_string": b"", "headers": [], "path_params": {}}
    present = False
    for route in routes:
        try:
            match = route.matches(dict(scope))[0]
        except Exception:
            return "unknown"
        if getattr(match, "value", match) == 0:
            continue
        if any(cls.__name__ in ("Mount", "Host") for cls in type(route).__mro__):
            return "unknown"
        present = True
    return "present" if present else "absent"


def _empty_list_when_missing(send):
    """Turns a 404 into an empty list (one start and one body message); any other answer passes unchanged."""
    replaced = False

    async def wrapped(message):
        nonlocal replaced
        if message["type"] == "http.response.start" and message["status"] == 404:
            replaced = True
            await send({"type": "http.response.start", "status": 200, "headers": EMPTY_LIST_HEADERS})
            await send({"type": "http.response.body", "body": b"[]"})
            return
        if replaced:
            return
        await send(message)

    return wrapped


EMPTY_LIST_HEADERS = [(b"content-type", b"application/json"), (b"cache-control", b"no-store"), (b"content-length", b"2")]


def guard(inner, hosts: frozenset[str], origins: frozenset[str], instance: str = ""):
    kb_route: str | None = None

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
        if reason is None and scope["type"] == "http" and scope.get("path") == INSTANCE_PATH:
            # Answered by the guard itself: which StudyOrbit checkout this DeepTutor belongs to. The launcher uses it to
            # tell its own guarded instance from another checkout's or an unguarded DeepTutor on the same port.
            body = json.dumps({"instance": instance}).encode()
            await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        if reason is None and scope["type"] == "http" and scope.get("path") == KB_LIST_PATH and scope.get("method") == "GET":
            # DeepTutor 1.7.4's web page asks for the knowledge-base list before it sends a chat message and gives up
            # when the request fails. The route belongs to the knowledge module, which StudyOrbit does not install
            # (there is no embedding service), so without an answer a typed message is never sent.
            # Decided once, at the first such request (after start-up, when every module has registered its routes):
            #   absent  - DeepTutor clearly has no such route: the guard answers an empty list itself;
            #   present - DeepTutor answers, whatever it answers;
            #   unknown - DeepTutor is asked and only a 404 is turned into an empty list. This is the fallback for
            #             anything the route table does not settle, so a real list is never replaced by an empty one.
            nonlocal kb_route
            if kb_route is None:
                kb_route = route_state(inner, KB_LIST_PATH)
            if kb_route == "absent":
                await send({"type": "http.response.start", "status": 200, "headers": EMPTY_LIST_HEADERS})
                await send({"type": "http.response.body", "body": b"[]"})
                return
            await inner(scope, receive, _empty_list_when_missing(send) if kb_route == "unknown" else send)
            return
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

    return guard(deeptutor_app, allowed_hosts(ports), origins, os.environ.get("STUDYORBIT_GUARD_INSTANCE", ""))


# Imported by the unit test with STUDYORBIT_GUARD_SKIP_APP=1, which only wants the pure functions.
app = None if os.environ.get("STUDYORBIT_GUARD_SKIP_APP") == "1" else _build()
