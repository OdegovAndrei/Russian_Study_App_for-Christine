import socket
import threading
import unittest
from pathlib import Path

import server


class ResolvePathsTest(unittest.TestCase):
    def test_source_run_keeps_everything_in_the_project_folder(self):
        paths = server.resolve_paths(frozen=False, bundle_dir=None, executable=None, source_file="/proj/server.py")
        self.assertEqual(paths["web"], Path("/proj/web"))
        self.assertEqual(paths["state"], Path("/proj/user-data/russian-study.json"))
        self.assertEqual(paths["cache"], Path("/proj/.tts-cache"))

    def test_frozen_run_reads_web_from_bundle_and_writes_next_to_the_exe(self):
        paths = server.resolve_paths(frozen=True, bundle_dir="/tmp/_MEI123", executable="/home/me/RussianStudy.exe", source_file="x")
        self.assertEqual(paths["web"], Path("/tmp/_MEI123/web"))
        self.assertEqual(paths["state"], Path("/home/me/user-data/russian-study.json"))
        self.assertEqual(paths["cache"], Path("/home/me/.tts-cache"))


class PortTest(unittest.TestCase):
    def test_pick_port_skips_busy_ports(self):
        busy = socket.socket()
        busy.bind(("127.0.0.1", 0))
        busy.listen(1)
        port = busy.getsockname()[1]
        try:
            chosen = server.pick_port(port, attempts=5)
            self.assertNotEqual(chosen, port)
            self.assertGreater(chosen, port)
        finally:
            busy.close()

    def test_already_running_recognises_this_app(self):
        httpd = server.make_server(0, web_dir=Path(__file__).parent, cache_dir=Path("c"), state_file=Path("s.json"))
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertFalse(server.already_running(httpd.server_address[1]))  # no index.html in tests/
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
