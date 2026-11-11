"""Ado.call retries network failures (DNS, refused connection) but not HTTP errors.

Run: python3 -m unittest discover -s azure-devops/tests/ado-standup
"""
import io
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "mods", "ado-standup"))
import standup  # noqa: E402


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


DNS = urllib.error.URLError(OSError(8, "nodename nor servname provided, or not known"))


class RetryTest(unittest.TestCase):
    def setUp(self):
        self.ado = standup.Ado("org", "proj", "tok")
        p = mock.patch.object(standup.time, "sleep")
        self.sleep = p.start()
        self.addCleanup(p.stop)

    def test_dns_failure_then_success_returns_data(self):
        with mock.patch.object(standup.urllib.request, "urlopen", side_effect=[DNS, Resp(b'{"ok": 1}')]) as u:
            self.assertEqual(self.ado.get("/x"), {"ok": 1})
        self.assertEqual(u.call_count, 2)
        self.sleep.assert_called()

    def test_gives_up_after_the_last_attempt_with_the_network_error(self):
        with mock.patch.object(standup.urllib.request, "urlopen", side_effect=[DNS] * standup.ATTEMPTS) as u:
            with self.assertRaises(urllib.error.URLError):
                self.ado.get("/x")
        self.assertEqual(u.call_count, standup.ATTEMPTS)

    def test_http_errors_are_not_retried(self):
        err = urllib.error.HTTPError("u", 404, "nf", {}, io.BytesIO(b'{"message": "gone"}'))
        with mock.patch.object(standup.urllib.request, "urlopen", side_effect=[err]) as u:
            with self.assertRaisesRegex(RuntimeError, "HTTP 404: gone"):
                self.ado.get("/x")
        self.assertEqual(u.call_count, 1)


if __name__ == "__main__":
    unittest.main()
