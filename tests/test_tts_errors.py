import asyncio
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import server


class WSHandshakeError(Exception):  # shaped like aiohttp.WSServerHandshakeError
    def __init__(self, status, message):
        super().__init__(f"{status}, message='{message}', url='wss://speech.example/?TrustedClientToken=abc'")
        self.status = status


class ClientConnectorError(Exception):  # shaped like aiohttp.ClientConnectorError
    pass


class ClassifyTest(unittest.TestCase):
    def test_missing_package(self):
        self.assertEqual(server.classify_tts_error(server.VoiceUnavailable("edge-tts is not installed"))["code"], "not_installed")

    def test_service_refused_us(self):
        info = server.classify_tts_error(WSHandshakeError(403, "Invalid response status"))
        self.assertEqual(info["code"], "rejected")
        self.assertEqual(info["status"], 403)
        self.assertNotIn("wss://", info["detail"])
        self.assertNotIn("TrustedClientToken", info["detail"])

    def test_network_problems(self):
        self.assertEqual(server.classify_tts_error(ClientConnectorError("Cannot connect to host"))["code"], "network")
        self.assertEqual(server.classify_tts_error(OSError(11001, "getaddrinfo failed"))["code"], "network")

    def test_timeout_and_empty_and_other(self):
        self.assertEqual(server.classify_tts_error(asyncio.TimeoutError())["code"], "timeout")
        self.assertEqual(server.classify_tts_error(server.VoiceUnavailable("empty audio", code="empty"))["code"], "empty")
        self.assertEqual(server.classify_tts_error(ValueError("boom"))["code"], "other")


class EndpointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "web").mkdir()
        self.httpd = server.make_server(0, web_dir=root / "web", cache_dir=root / "cache", state_file=root / "s.json")
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("GET", path, headers={"Host": f"localhost:{self.port}"})
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, data

    def test_failed_synthesis_reports_code_status_and_detail(self):
        async def refuse(text, voice, rate):
            raise WSHandshakeError(403, "Invalid response status")

        with mock.patch.object(server, "synthesize", refuse):
            status, data = self.get("/tts?text=%D0%B4%D0%B0&voice=ru-RU-DmitryNeural")
        body = json.loads(data)
        self.assertEqual(status, 502)
        self.assertEqual(body["code"], "rejected")
        self.assertEqual(body["status"], 403)
        self.assertIn("403", body["detail"])
        self.assertEqual(body["voice"], "ru-RU-DmitryNeural")


if __name__ == "__main__":
    unittest.main()
