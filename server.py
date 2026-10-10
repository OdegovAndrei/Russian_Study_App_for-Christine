#!/usr/bin/env python3
"""Russian Study: tiny local server (static files, saved progress, Russian speech)."""
import asyncio
import hashlib
import json
import os
import re
import socket
import sys
import tempfile
import threading
import urllib.request
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import edge_tts
except ImportError:  # the browser voice is used instead
    edge_tts = None

def resolve_paths(frozen, bundle_dir, executable, source_file):
    """Where to read the interface from and where to keep user data.

    From source everything lives in the project folder. In a PyInstaller
    build the interface is unpacked into a temp bundle, while progress and
    the speech cache stay next to the executable so they survive restarts.
    """
    if frozen:
        data_root = Path(executable).parent
        web = Path(bundle_dir) / "web"
    else:
        data_root = Path(source_file).resolve().parent
        web = data_root / "web"
    return {
        "web": web,
        "cache": data_root / ".tts-cache",
        "state": data_root / "user-data" / "russian-study.json",
    }


FROZEN = bool(getattr(sys, "frozen", False))
_PATHS = resolve_paths(FROZEN, getattr(sys, "_MEIPASS", None), sys.executable, __file__)
WEB_DIR = _PATHS["web"]
CACHE_DIR = _PATHS["cache"]
STATE_FILE = _PATHS["state"]
DEFAULT_PORT = 5174
VOICES = {"ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural"}
MAX_STATE_BYTES = 32 * 1024 * 1024
DAILY_BACKUPS_TO_KEEP = 7
MAX_TTS_CHARS = 600
STATE_LOCK = threading.Lock()


def normalize_text(text):
    return " ".join(text.split("\n", 1)[0].split())


def round_rate_percent(rate):
    return round(((float(rate) - 1) * 100) / 5) * 5


def cache_key(text, voice, rate):
    payload = f"{normalize_text(text)}|{voice}|{round_rate_percent(rate)}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class VoiceUnavailable(Exception):
    def __init__(self, message, code="other"):
        super().__init__(message)
        self.code = code


TTS_TIMEOUT_SECONDS = 20


def classify_tts_error(error):
    """Turns a synthesis failure into a stable code the interface can explain.

    Codes: not_installed, rejected (the speech service refused us, e.g. 403),
    network, timeout, empty, other. `detail` is short and has no URLs.
    """
    status = getattr(error, "status", None)
    status = status if isinstance(status, int) else None
    message = " ".join(str(error).split())
    message = re.sub(r",?\s*url='[^']*'?", "", message)
    message = re.sub(r"(wss?|https?)://\S+", "", message).strip(" ,")
    name = type(error).__name__
    if isinstance(error, VoiceUnavailable):
        code = error.code if error.code != "other" else "not_installed"
    elif isinstance(error, asyncio.TimeoutError):
        code = "timeout"
    elif status in (401, 403, 429):
        code = "rejected"
    elif isinstance(error, OSError) or "Connect" in name or "getaddrinfo" in message or "Cannot connect" in message:
        code = "network"
    else:
        code = "other"
    detail = f"{name}: {message}".strip(": ")[:240]
    return {"code": code, "status": status, "detail": detail}


async def synthesize(text, voice, rate):
    if edge_tts is None:
        raise VoiceUnavailable("edge-tts is not installed", code="not_installed")
    percent = round_rate_percent(rate)
    communicate = edge_tts.Communicate(normalize_text(text), voice, rate=f"{percent:+d}%")
    chunks = bytearray()

    async def collect():
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.extend(chunk["data"])

    await asyncio.wait_for(collect(), TTS_TIMEOUT_SECONDS)
    if not chunks:
        raise VoiceUnavailable("empty audio", code="empty")
    return bytes(chunks)


def fsync_directory(directory):
    """Best effort: make the rename itself durable (not possible on Windows)."""
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def read_state_file(path):
    """Returns the parsed object, or None when the file is missing. Raises ValueError if corrupt."""
    try:
        raw = path.read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError):
        return None
    state = json.loads(raw)
    if not isinstance(state, dict):
        raise ValueError("state is not an object")
    return state


def standard_data_dir():
    """The per-user place applications normally keep their data."""
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming") / "RussianStudy"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "RussianStudy"
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "RussianStudy"


def format_words(state):
    """One `french ; russian` pair per line: readable, and importable with "add several words"."""
    def clean(text):
        return " ".join(str(text).replace(";", ",").replace("|", "/").split())

    lines = []
    for item in state.get("custom", []):
        if isinstance(item, dict) and item.get("fr") and item.get("ru"):
            lines.append(f"{clean(item['fr'])} ; {clean(item['ru'])}")
    return ("\n".join(lines) + "\n") if lines else ""


def backup_paths(state_file):
    return state_file.with_name("russian-study.backup.json"), state_file.parent / "backups"


def keep_backups(state_file):
    """Copies the current file aside (latest + one per day, newest 7 days) before it is replaced."""
    try:
        current = read_state_file(state_file)
    except (OSError, ValueError):
        return  # never replace a good backup with a damaged file
    if current is None:
        return
    raw = state_file.read_bytes()
    latest, daily_dir = backup_paths(state_file)
    atomic_write(latest, raw)
    today = datetime.now().strftime("%Y-%m-%d")
    daily = daily_dir / f"russian-study-{today}.json"
    if not daily.exists():
        atomic_write(daily, raw)
    old = sorted(daily_dir.glob("russian-study-*.json"))
    for path in old[:-DAILY_BACKUPS_TO_KEEP]:
        try:
            path.unlink()
        except OSError:
            pass


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
        fsync_directory(path.parent)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


class Handler(SimpleHTTPRequestHandler):
    web_dir = WEB_DIR
    cache_dir = CACHE_DIR
    state_file = STATE_FILE
    mirror_dir = None   # second place: the standard per-user data folder
    words_file = None   # third place: a readable word list next to the app
    mirror_status = {}
    # Windows reads MIME types from the registry, where .js is sometimes
    # "text/plain" and browsers then refuse to run ES modules.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".html": "text/html",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.web_dir), **kwargs)

    # -- safety ----------------------------------------------------------
    def permitted_origins(self):
        port = self.server.server_address[1]
        return {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}

    def is_allowed_request(self):
        origins = self.permitted_origins()
        hosts = self.headers.get_all("Host", [])
        allowed_hosts = {urlparse(origin).netloc.lower() for origin in origins}
        if len(hosts) != 1 or hosts[0].strip().lower() not in allowed_hosts:
            self.send_json(403, {"error": "Adresse non autorisée."})
            return False
        origin = self.headers.get("Origin")
        cross_site = self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site"
        if cross_site or (origin and origin.rstrip("/") not in origins):
            self.send_json(403, {"error": "Requête d'un autre site refusée."})
            return False
        return True

    def end_headers(self):
        path = urlparse(self.path).path
        if path == "/" or Path(path).suffix.lower() in {".html", ".js", ".css", ".json"}:
            self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    # -- routing ---------------------------------------------------------
    def do_GET(self):
        if not self.is_allowed_request():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            return self.handle_state_get()
        if parsed.path == "/api/storage":
            return self.handle_storage_info()
        if parsed.path == "/tts":
            return self.handle_tts(parse_qs(parsed.query))
        super().do_GET()

    def do_HEAD(self):
        if self.is_allowed_request():
            super().do_HEAD()

    def do_PUT(self):
        if not self.is_allowed_request():
            return
        if urlparse(self.path).path == "/api/state":
            return self.handle_state_put()
        self.send_json(404, {"error": "Not found"})

    def list_directory(self, path):
        self.send_json(404, {"error": "Not found"})
        return None

    # -- progress --------------------------------------------------------
    def mirror_file(self):
        return self.mirror_dir / "russian-study.json" if self.mirror_dir else None

    def load_best_state(self):
        """(state, source, found_something). Order: main file, last backup, standard-folder copy."""
        found = False
        candidates = [
            ("main", self.state_file),
            ("backup", backup_paths(self.state_file)[0]),
            ("appdata", self.mirror_file()),
        ]
        for source, path in candidates:
            if path is None:
                continue
            try:
                state = read_state_file(path)
            except (OSError, ValueError):
                found = True  # a file exists but cannot be used
                continue
            if state is not None:
                return state, source, True
        return None, None, found

    def handle_state_get(self):
        with STATE_LOCK:
            state, source, found = self.load_best_state()
        if state is None:
            if found:
                return self.send_json(500, {"error": "Fichier de progression illisible."})
            return self.send_json(200, {"exists": False, "state": None})
        payload = {"exists": True, "state": state}
        if source != "main":
            payload["recovered"] = True
        self.send_json(200, payload)

    def write_extra_places(self, state):
        """Best effort: a failure here must never fail the save itself."""
        status = {}
        try:
            mirror = self.mirror_file()
            if mirror is not None:
                atomic_write(mirror, json.dumps(state, ensure_ascii=False).encode("utf-8"))
            status["appdata"] = None
        except Exception as error:  # noqa: BLE001 - report, don't crash
            status["appdata"] = str(error)
        try:
            if self.words_file is not None:
                atomic_write(self.words_file, format_words(state).encode("utf-8"))
            status["words"] = None
        except Exception as error:  # noqa: BLE001
            status["words"] = str(error)
        type(self).mirror_status = status

    def handle_storage_info(self):
        status = type(self).mirror_status
        places = [{"id": "local", "path": str(self.state_file), "ok": True}]
        if self.mirror_dir is not None:
            places.append({"id": "appdata", "path": str(self.mirror_file()), "ok": status.get("appdata") is None})
        else:
            places.append({"id": "appdata", "path": "", "ok": False})
        if self.words_file is not None:
            places.append({"id": "words", "path": str(self.words_file), "ok": status.get("words") is None})
        else:
            places.append({"id": "words", "path": "", "ok": False})
        self.send_json(200, {"places": places})

    def handle_state_put(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_json(400, {"error": "Content-Length invalide"})
        if length <= 0 or length > MAX_STATE_BYTES:
            return self.send_json(400, {"error": "Taille invalide"})
        body = self.rfile.read(length)
        try:
            state = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self.send_json(400, {"error": "JSON invalide"})
        if not isinstance(state, dict):
            return self.send_json(400, {"error": "Un objet JSON est attendu"})
        with STATE_LOCK:
            on_disk, _, found = self.load_best_state()
            if on_disk is None and found:
                return self.send_json(500, {"error": "Lecture impossible"})
            disk_rev = int(on_disk.get("rev", 0)) if on_disk and str(on_disk.get("rev", 0)).isdigit() else 0
            client_rev = state.get("rev", 0)
            if not isinstance(client_rev, int) or client_rev < disk_rev:
                return self.send_json(409, {"error": "Modifié ailleurs", "rev": disk_rev})
            state["rev"] = disk_rev + 1
            try:
                keep_backups(self.state_file)
                atomic_write(self.state_file, json.dumps(state, ensure_ascii=False).encode("utf-8"))
            except OSError as error:
                return self.send_json(500, {"error": f"Écriture impossible: {error}"})
            self.write_extra_places(state)
        self.send_json(200, {"ok": True, "rev": state["rev"]})

    # -- speech ----------------------------------------------------------
    def handle_tts(self, query):
        text = query.get("text", [""])[0]
        voice = query.get("voice", ["ru-RU-SvetlanaNeural"])[0]
        if not text.strip() or len(text) > MAX_TTS_CHARS:
            return self.send_json(400, {"error": "Texte manquant ou trop long"})
        if voice not in VOICES:
            return self.send_json(400, {"error": "Voix inconnue"})
        try:
            rate = float(query.get("rate", ["1"])[0])
            if not 0.5 <= rate <= 1.5:
                raise ValueError
        except ValueError:
            return self.send_json(400, {"error": "Vitesse invalide"})
        path = self.cache_dir / f"{cache_key(text, voice, rate)}.mp3"
        if not path.exists():
            try:
                audio = asyncio.run(synthesize(text, voice, rate))
            except Exception as error:  # network off, package missing...
                info = classify_tts_error(error)
                return self.send_json(502, {
                    "error": "Synthèse indisponible",
                    "voice": voice,
                    **info,
                })
            atomic_write(path, audio)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, format_string, *args):
        pass


def make_server(port, web_dir=WEB_DIR, cache_dir=CACHE_DIR, state_file=STATE_FILE, mirror_dir=None, words_file=None):
    handler = type("BoundHandler", (Handler,), {
        "web_dir": Path(web_dir),
        "cache_dir": Path(cache_dir),
        "state_file": Path(state_file),
        "mirror_dir": Path(mirror_dir) if mirror_dir else None,
        "words_file": Path(words_file) if words_file else None,
        "mirror_status": {},
    })
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def pick_port(start, attempts=10):
    """First free port in [start, start + attempts)."""
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if sys.platform != "win32":
                # Same as the real server: a port in TIME_WAIT after a restart is usable.
                # (On Windows this option would allow stealing a busy port, so it is skipped.)
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise OSError(f"Aucun port libre entre {start} et {start + attempts - 1}")


def already_running(port):
    """True when Russian Study itself already answers on this port."""
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/", timeout=1.5) as reply:
            return b"Russian Study" in reply.read(4096)
    except (OSError, ValueError):
        return False


def main():
    requested = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    if already_running(requested):
        print(f"Russian Study tourne deja: http://localhost:{requested}", flush=True)
        webbrowser.open(f"http://localhost:{requested}/")
        return
    port = pick_port(requested)
    httpd = make_server(
        port,
        mirror_dir=standard_data_dir(),
        words_file=STATE_FILE.parent.parent / "my-words.txt",
    )
    print(f"Russian Study: http://localhost:{port}  (Ctrl+C pour arreter)", flush=True)
    if FROZEN:
        print("Fermez cette fenetre pour arreter l'application.", flush=True)
        threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{port}/")).start()
    if edge_tts is None:
        print("edge-tts n'est pas installe: la voix du navigateur sera utilisee.", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
