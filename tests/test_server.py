import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import server


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "web").mkdir()
        (root / "web" / "index.html").write_text("<h1>ok</h1>", encoding="utf-8")
        self.cache_dir = root / "cache"
        self.state_file = root / "user-data" / "state.json"
        self.httpd = server.make_server(0, web_dir=root / "web", cache_dir=self.cache_dir, state_file=self.state_file)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        request_headers = {"Host": f"localhost:{self.port}", **(headers or {})}
        conn.request(method, path, body=body, headers=request_headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, data

    def test_state_starts_empty_and_round_trips(self):
        status, data = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {"exists": False, "state": None})
        payload = json.dumps({"version": 1, "schedules": {"a|fr-ru": {"due": 5}}}).encode()
        status, _ = self.request("PUT", "/api/state", payload, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        status, data = self.request("GET", "/api/state")
        body = json.loads(data)
        self.assertTrue(body["exists"])
        self.assertEqual(body["state"]["schedules"]["a|fr-ru"]["due"], 5)
        self.assertTrue(self.state_file.exists())

    def test_state_rejects_non_object(self):
        status, _ = self.request("PUT", "/api/state", b"[1,2]", {"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        status, _ = self.request("PUT", "/api/state", b"not json", {"Content-Type": "application/json"})
        self.assertEqual(status, 400)

    def test_foreign_host_and_cross_site_are_rejected(self):
        status, _ = self.request("GET", "/api/state", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("GET", "/api/state", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)
        status, _ = self.request("PUT", "/api/state", b"{}", {"Origin": "http://evil.example"})
        self.assertEqual(status, 403)

    def test_tts_validates_input(self):
        status, _ = self.request("GET", "/tts?text=")
        self.assertEqual(status, 400)
        status, _ = self.request("GET", "/tts?text=hi&voice=en-US-Nope")
        self.assertEqual(status, 400)
        status, _ = self.request("GET", "/tts?text=hi&rate=fast")
        self.assertEqual(status, 400)

    def test_tts_serves_cached_audio_without_synthesis(self):
        self.cache_dir.mkdir(parents=True)
        key = server.cache_key("привет", "ru-RU-SvetlanaNeural", 1.0)
        (self.cache_dir / f"{key}.mp3").write_bytes(b"ID3fake")
        status, data = self.request("GET", "/tts?text=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82&voice=ru-RU-SvetlanaNeural&rate=1")
        self.assertEqual(status, 200)
        self.assertEqual(data, b"ID3fake")

    def test_script_and_style_types_do_not_depend_on_the_os_registry(self):
        web = Path(self.tmp.name) / "web"
        (web / "app.js").write_text("export {};", encoding="utf-8")
        (web / "styles.css").write_text("a{}", encoding="utf-8")
        for name, expected in (("app.js", "javascript"), ("styles.css", "text/css")):
            conn = http.client.HTTPConnection("127.0.0.1", self.port)
            conn.request("GET", f"/{name}", headers={"Host": f"localhost:{self.port}"})
            response = conn.getresponse()
            response.read()
            conn.close()
            self.assertIn(expected, response.getheader("Content-Type"))

    def test_static_files_served_and_private_paths_hidden(self):
        status, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"ok", data)
        status, _ = self.request("GET", "/user-data/state.json")
        self.assertEqual(status, 404)
        status, _ = self.request("GET", "/../server.py")
        self.assertIn(status, (400, 404))


if __name__ == "__main__":
    unittest.main()
