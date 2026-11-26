#!/usr/bin/env python3
"""
Affective Echoes — local lab server (Python 3.9+, standard library only).

  * Serves the web app at http://localhost:8000
  * Proxies chatbot requests to an LLM so the API key never reaches the browser
  * Appends every logged event to data/<PID>/<PID>_<date>.jsonl
  * Optionally pushes event markers to Lab Streaming Layer (pip install pylsl)
    so LabRecorder can store them alongside EEG / EmotiBit streams.

Language model. By default the built-in model is used: Llama 3.2 3B running
locally through llama.cpp (see llm_service.py). No API key needed.
Set AE_LLM in the environment or `.env` to choose:
  AE_LLM=auto     (default) built-in model if its files are present, else a cloud key, else ask to download
  AE_LLM=local    built-in model only
  AE_LLM=cloud    use the keys below (or Ollama via OPENAI_BASE_URL)
  AE_LLM=off      scripted lines only

Cloud / Ollama settings (only used with AE_LLM=cloud, or auto without the built-in model):
  ANTHROPIC_API_KEY=...
  ANTHROPIC_MODEL=claude-haiku-5-5
  -- or --
  OPENAI_API_KEY=...
  OPENAI_MODEL=gpt-4o-mini
  OPENAI_BASE_URL=https://api.openai.com/v1   (any OpenAI-compatible endpoint)

  PORT=8000
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import os as _os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:   # the portable Windows Python doesn't add the script's folder itself
    sys.path.insert(0, str(ROOT))
PUBLIC = ROOT / "public"
DATA = ROOT / "data"


def load_dotenv():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv()

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-5-5")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
PORT = int(os.environ.get("PORT", "8000"))
AE_LLM = os.environ.get("AE_LLM", "auto").strip().lower()

import llm_service  # noqa: E402  (after .env is loaded, so its settings apply)

CLOUD = None
if ANTHROPIC_KEY:
    CLOUD = {"provider": "anthropic", "model": ANTHROPIC_MODEL}
elif OPENAI_KEY:
    CLOUD = {"provider": "openai", "model": OPENAI_MODEL}

if AE_LLM == "off":
    MODE = "off"
elif AE_LLM == "cloud":
    MODE = "cloud" if CLOUD else "off"
elif AE_LLM == "local":
    MODE = "local"
else:  # auto
    MODE = "local" if llm_service.LocalLLM.get().available() or not CLOUD else "cloud"

LOCAL = llm_service.LocalLLM.get() if MODE == "local" else None


def llm_info():
    """What the console shows about the language model."""
    if MODE == "local":
        return LOCAL.status()
    if MODE == "cloud":
        return {**CLOUD, "state": "ready"}
    return None

# ---------------- Optional LSL marker stream ----------------
LSL_OUTLET = None
try:
    from pylsl import StreamInfo, StreamOutlet, local_clock  # type: ignore

    _info = StreamInfo("AffectiveEchoesMarkers", "Markers", 1, 0, "string", "affective-echoes-markers")
    LSL_OUTLET = StreamOutlet(_info)
except Exception:
    local_clock = None


def push_lsl(ev):
    if not LSL_OUTLET or ev.get("type") == "affect_sample":
        return
    marker = {k: ev.get(k) for k in ("type", "phase", "phase_kind", "block", "strategy", "probe_id", "t_epoch_ms") if ev.get(k) is not None}
    LSL_OUTLET.push_sample([json.dumps(marker)])


# ---------------- LLM call ----------------
def http_json(url, payload, headers, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def call_llm(system, messages, max_tokens=160, temperature=0.7):
    if MODE == "local":
        return LOCAL.chat(system, messages, max_tokens, temperature)
    if MODE != "cloud":
        raise RuntimeError("No language model configured")
    if CLOUD["provider"] == "anthropic":
        d = http_json(
            "https://api.anthropic.com/v1/messages",
            {"model": ANTHROPIC_MODEL, "system": system, "messages": messages,
             "max_tokens": max_tokens, "temperature": temperature},
            {"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01"},
        )
        return "".join(b.get("text", "") for b in d.get("content", []) if b.get("type") == "text")
    d = http_json(
        f"{OPENAI_BASE}/chat/completions",
        {"model": OPENAI_MODEL, "messages": [{"role": "system", "content": system}] + messages,
         "max_tokens": max_tokens, "temperature": temperature},
        {"Authorization": f"Bearer {OPENAI_KEY}"},
    )
    return d["choices"][0]["message"]["content"]


def safe_pid(pid):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(pid or "unknown"))[:40] or "unknown"


# ---------------- Session library (for the review view) ----------------
def session_path(rel):
    """Resolve a data/<PID>/<file>.jsonl path safely (no traversal outside data/)."""
    if not rel or not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.jsonl", rel):
        return None
    p = (DATA / rel).resolve()
    try:
        p.relative_to(DATA.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def summarize_session(path):
    """Read only the lines needed for the library card (skips affect samples quickly)."""
    s = {"file": path.relative_to(DATA).as_posix(), "bytes": path.stat().st_size,
         "probes_answered": 0, "probes_missed": 0, "interruptions": 0, "user_messages": 0,
         "phases_done": 0, "ended": None, "last_t": 0}
    with path.open(encoding="utf-8") as f:
        for line in f:
            if '"affect_sample"' in line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = ev.get("type")
            s["last_t"] = max(s["last_t"], ev.get("t_session_s") or 0)
            if t == "session_start":
                s.update(pid=ev.get("pid"), condition=ev.get("condition"), order=ev.get("order"),
                         start_epoch_ms=ev.get("start_epoch_ms") or ev.get("t_epoch_ms"),
                         speed=ev.get("speed"), llm=ev.get("llm"), checklist=ev.get("checklist"),
                         demo=bool(ev.get("demo")), simulated=bool(ev.get("simulated")))
            elif t == "session_end":
                s["ended"] = ev.get("reason")
            elif t == "probe_response":
                s["probes_answered"] += 1
            elif t == "probe_missed":
                s["probes_missed"] += 1
            elif t == "bot_interrupted":
                s["interruptions"] += 1
            elif t == "user_message":
                s["user_messages"] += 1
            elif t == "phase_end":
                s["phases_done"] += 1
    return s


def list_sessions():
    if not DATA.exists():
        return []
    out = []
    for p in sorted(DATA.glob("*/*.jsonl")):
        try:
            out.append(summarize_session(p))
        except OSError:
            continue
    out.sort(key=lambda s: s.get("start_epoch_ms") or 0, reverse=True)
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PUBLIC), **kw)

    def log_message(self, fmt, *args):  # keep the console quiet except for API calls
        if args and "/api/" in str(args[0]):
            sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n).decode() or "{}")

    def do_GET(self):
        if self.path.startswith("/api/emotion/"):
            return self._proxy_emotion("GET")
        if self.path == "/api/health":
            return self._json(200, {"ok": True, "llm": llm_info(), "log_dir": str(DATA), "lsl": LSL_OUTLET is not None,
                                    "server_epoch_ms": time.time() * 1000})
        if self.path == "/api/sessions":
            return self._json(200, {"sessions": list_sessions()})
        if self.path.startswith("/api/session?"):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            path = session_path(q.get("file", [""])[0])
            if not path:
                return self._json(404, {"error": "session not found"})
            events = []
            with path.open(encoding="utf-8") as f:
                for line in f:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
            return self._json(200, {"file": path.relative_to(DATA).as_posix(), "events": events})
        return super().do_GET()

    def do_POST(self):
        try:
            if self.path.startswith("/api/emotion/"):
                return self._proxy_emotion("POST")
            if self.path == "/api/chat":
                b = self._body()
                t0 = time.time()
                text = call_llm(b.get("system", ""), b.get("messages", []),
                                int(b.get("max_tokens", 160)), float(b.get("temperature", 0.7)))
                return self._json(200, {"text": text.strip(), "latency_ms": round((time.time() - t0) * 1000)})
            if self.path == "/api/model/download":
                if MODE != "local":
                    return self._json(400, {"error": "The built-in model isn't in use (AE_LLM setting)."})
                started = LOCAL.download_async()
                return self._json(200, {"started": started, "llm": LOCAL.status()})
            if self.path == "/api/log":
                b = self._body()
                pid = safe_pid(b.get("pid"))
                folder = DATA / pid
                folder.mkdir(parents=True, exist_ok=True)
                try:
                    start = time.strftime("%Y%m%d_%H%M%S", time.localtime(float(b.get("session_start_epoch_ms")) / 1000))
                except (TypeError, ValueError):
                    start = time.strftime("%Y%m%d")
                path = folder / f"{pid}_{start}.jsonl"
                recv = time.time() * 1000
                with path.open("a", encoding="utf-8") as f:
                    for ev in b.get("events", []):
                        ev["server_recv_epoch_ms"] = round(recv, 2)
                        if local_clock:
                            ev["lsl_clock_s"] = local_clock()
                        f.write(json.dumps(ev) + "\n")
                        push_lsl(ev)
                return self._json(200, {"ok": True, "n": len(b.get("events", []))})
            return self._json(404, {"error": "not found"})
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": f"LLM HTTP {e.code}: {e.read().decode()[:300]}"})
        except RuntimeError as e:          # built-in model still loading / not configured
            return self._json(503, {"error": str(e)})
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def _proxy_emotion(self, method):
        """Same-origin bridge to the local Light-MER service. Media is never logged here."""
        route = self.path.split("?", 1)[0].removeprefix("/api/emotion")
        target = {"/health": "/api/health", "/session": "/api/session",
                  "/window": "/api/window", "/state": "/api/state", "/stop": "/api/stop"}.get(route)
        if not target:
            return self._json(404, {"error": "unknown emotion route"})
        base = _os.environ.get("AE_EMOTION_URL", "http://127.0.0.1:8770").rstrip("/")
        headers = {}
        body = None
        if method == "POST":
            payload = self._body()
            token = payload.pop("session_token", None)
            body = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
            if token:
                headers["x-session-token"] = str(token)
        else:
            token = self.headers.get("x-session-token")
            if token:
                headers["x-session-token"] = token
        req = urllib.request.Request(base + target, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return self._json(response.status, json.loads(response.read().decode() or "{}"))
        except urllib.error.HTTPError as e:
            try: data = json.loads(e.read().decode() or "{}")
            except Exception: data = {"error": f"Emotion service returned {e.code}"}
            return self._json(e.code, data)


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    print("Affective Echoes server")
    print(f"  App:  http://localhost:{PORT}")
    if MODE == "local":
        LOCAL.start_async()
        ram = llm_service.total_ram_gb()
        print(f"  LLM:  {llm_service.MODEL_NAME} built in, loading in the background"
              + (f" ({ram:.0f} GB RAM)" if ram else ""))
        if ram and ram < 7.5:
            print("        Note: under 8 GB of RAM. Close other apps; replies may be slow.")
    elif MODE == "cloud":
        print(f"  LLM:  {CLOUD['provider']} / {CLOUD['model']}")
    else:
        print("  LLM:  none (scripted fallback lines)")
    print(f"  Logs: {DATA}")
    print(f"  LSL:  {'marker stream AffectiveEchoesMarkers ON' if LSL_OUTLET else 'off (pip install pylsl to enable)'}")
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    if "--no-browser" not in sys.argv and not os.environ.get("NO_BROWSER"):
        import threading, webbrowser
        threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    print("  Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if LOCAL:
            LOCAL.stop()
