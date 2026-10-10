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

    def start_with_mirrors(self):
        """Restart the server with the second and third storage places enabled."""
        self.httpd.shutdown()
        self.httpd.server_close()
        root = Path(self.tmp.name)
        self.mirror_dir = root / "appdata" / "RussianStudy"
        self.words_file = root / "my-words.txt"
        self.httpd = server.make_server(
            0, web_dir=root / "web", cache_dir=self.cache_dir, state_file=self.state_file,
            mirror_dir=self.mirror_dir, words_file=self.words_file,
        )
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

    def put_state(self, state):
        return self.request("PUT", "/api/state", json.dumps(state).encode(), {"Content-Type": "application/json"})

    def get_state(self):
        status, data = self.request("GET", "/api/state")
        return status, json.loads(data)

    def test_revision_increments_and_stale_writers_are_rejected(self):
        status, data = self.put_state({"custom": [1]})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["rev"], 1)
        status, data = self.put_state({"custom": [1, 2], "rev": 1})
        self.assertEqual(json.loads(data)["rev"], 2)
        # a second window still holding revision 1 must not overwrite revision 2
        status, data = self.put_state({"custom": ["stale"], "rev": 1})
        self.assertEqual(status, 409)
        _, body = self.get_state()
        self.assertEqual(body["state"]["custom"], [1, 2])

    def test_previous_version_is_kept_as_backup_and_daily_copy(self):
        self.put_state({"custom": ["first"]})
        _, data = self.put_state({"custom": ["second"], "rev": 1})
        backup = json.loads((self.state_file.parent / "russian-study.backup.json").read_text(encoding="utf-8"))
        self.assertEqual(backup["custom"], ["first"])
        daily = list((self.state_file.parent / "backups").glob("russian-study-*.json"))
        self.assertEqual(len(daily), 1)

    def test_old_daily_backups_are_pruned_to_seven(self):
        backups = self.state_file.parent / "backups"
        backups.mkdir(parents=True)
        for day in range(1, 11):
            (backups / f"russian-study-2020-01-{day:02d}.json").write_text("{}", encoding="utf-8")
        self.put_state({"custom": []})
        self.put_state({"custom": ["x"], "rev": 1})
        names = sorted(path.name for path in backups.glob("russian-study-*.json"))
        self.assertEqual(len(names), 7)
        self.assertNotIn("russian-study-2020-01-01.json", names)

    def test_corrupt_state_file_falls_back_to_backup(self):
        self.put_state({"custom": ["keep"]})
        self.put_state({"custom": ["keep", "more"], "rev": 1})
        self.state_file.write_text("{ not json", encoding="utf-8")
        status, body = self.get_state()
        self.assertEqual(status, 200)
        self.assertTrue(body["recovered"])
        self.assertEqual(body["state"]["custom"], ["keep"])

    def test_corrupt_state_without_backup_is_an_error_not_an_empty_state(self):
        self.state_file.parent.mkdir(parents=True)
        self.state_file.write_text("{ not json", encoding="utf-8")
        status, _ = self.get_state()
        self.assertEqual(status, 500)

    WORDS_STATE = {"custom": [
        {"id": "a", "fr": "bonjour", "ru": "здравствуйте", "kind": "custom"},
        {"id": "b", "fr": "un livre ; une œuvre", "ru": "книга", "kind": "custom"},
    ]}

    def test_every_save_is_mirrored_to_appdata_and_a_readable_words_file(self):
        self.start_with_mirrors()
        status, _ = self.put_state(self.WORDS_STATE)
        self.assertEqual(status, 200)
        mirrored = json.loads((self.mirror_dir / "russian-study.json").read_text(encoding="utf-8"))
        self.assertEqual(len(mirrored["custom"]), 2)
        lines = self.words_file.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "bonjour ; здравствуйте")
        self.assertEqual(len(lines), 2)
        # the exported file can be pasted straight back into "add several words"
        self.assertEqual(lines[1].count(";"), 1)

    def test_progress_is_restored_from_appdata_when_the_local_file_is_gone(self):
        self.start_with_mirrors()
        self.put_state(self.WORDS_STATE)
        self.state_file.unlink()
        status, body = self.get_state()
        self.assertEqual(status, 200)
        self.assertTrue(body["recovered"])
        self.assertEqual(len(body["state"]["custom"]), 2)

    def test_a_failing_mirror_never_fails_the_save(self):
        self.start_with_mirrors()
        self.mirror_dir.parent.mkdir(parents=True)
        self.mirror_dir.write_text("i am a file, not a folder", encoding="utf-8")
        status, _ = self.put_state(self.WORDS_STATE)
        self.assertEqual(status, 200)
        self.assertTrue(self.state_file.exists())
        status, data = self.request("GET", "/api/storage")
        places = json.loads(data)["places"]
        self.assertEqual([place["ok"] for place in places], [True, False, True])

    def test_storage_info_lists_the_three_places(self):
        self.start_with_mirrors()
        self.put_state(self.WORDS_STATE)
        status, data = self.request("GET", "/api/storage")
        self.assertEqual(status, 200)
        places = json.loads(data)["places"]
        self.assertEqual([place["id"] for place in places], ["local", "appdata", "words"])
        self.assertTrue(all(place["path"] for place in places))

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
