#!/usr/bin/env python3
"""Russian Study: tiny local server (static files, saved progress, Russian speech)."""
import asyncio
import hashlib
import json
import os
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import edge_tts
except ImportError:  # the browser voice is used instead
    edge_tts = None

PROJECT_DIR = Path(__file__).resolve().parent
WEB_DIR = PROJECT_DIR / "web"
CACHE_DIR = PROJECT_DIR / ".tts-cache"
STATE_FILE = PROJECT_DIR / "user-data" / "russian-study.json"
DEFAULT_PORT = 5174
VOICES = {"ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural"}
MAX_STATE_BYTES = 8 * 1024 * 1024
MAX_TTS_CHARS = 600
STATE_LOCK = threading.Lock()


def normalize_text(text):
    return " ".join(text.split("\n", 1)[0].split())


def round_rate_percent(rate):
    return round(((float(rate) - 1) * 100) / 5) * 5


def cache_key(text, voice, rate):
    payload = f"{normalize_text(text)}|{voice}|{round_rate_percent(rate)}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def synthesize(text, voice, rate):
    if edge_tts is None:
        raise RuntimeError("edge-tts is not installed")
    percent = round_rate_percent(rate)
    communicate = edge_tts.Communicate(normalize_text(text), voice, rate=f"{percent:+d}%")
    chunks = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.extend(chunk["data"])
    if not chunks:
        raise RuntimeError("empty audio")
    return bytes(chunks)


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
        os.replace(temp_name, path)
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
    def handle_state_get(self):
        with STATE_LOCK:
            try:
                state = json.loads(self.state_file.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return self.send_json(200, {"exists": False, "state": None})
            except (OSError, ValueError):
                return self.send_json(500, {"error": "Fichier de progression illisible."})
        self.send_json(200, {"exists": True, "state": state})

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
            try:
                atomic_write(self.state_file, json.dumps(state, ensure_ascii=False).encode("utf-8"))
            except OSError as error:
                return self.send_json(500, {"error": f"Écriture impossible: {error}"})
        self.send_json(200, {"ok": True})

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
                return self.send_json(502, {"error": f"Synthèse indisponible: {error}"})
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


def make_server(port, web_dir=WEB_DIR, cache_dir=CACHE_DIR, state_file=STATE_FILE):
    handler = type("BoundHandler", (Handler,), {
        "web_dir": Path(web_dir),
        "cache_dir": Path(cache_dir),
        "state_file": Path(state_file),
    })
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    httpd = make_server(port)
    print(f"Russian Study: http://localhost:{port}  (Ctrl+C pour arreter)")
    if edge_tts is None:
        print("edge-tts n'est pas installe: la voix du navigateur sera utilisee.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
