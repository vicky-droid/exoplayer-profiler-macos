"""SSRF guard for the ffprobe downloader (plan 1.18)."""
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from bridge import ffprobe  # noqa: E402


def _resolver(ip):
    return lambda host, port: [(2, 1, 6, "", (ip, 80))]


class AddressClassTest(unittest.TestCase):

    def test_refused_ranges(self):
        for ip in ("127.0.0.1", "10.0.0.5", "192.168.1.34", "172.16.4.1", "169.254.169.254",
                   "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "::ffff:127.0.0.1", "fc00::1", "not-an-ip"):
            self.assertTrue(ffprobe.address_is_refused(ip), ip)

    def test_public_addresses_allowed(self):
        for ip in ("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"):
            self.assertFalse(ffprobe.address_is_refused(ip), ip)


class HostCheckTest(unittest.TestCase):

    def test_metadata_and_loopback_urls_are_refused(self):
        for url in ("http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:9091/uploads/x.json"):
            with self.assertRaises(ffprobe.ProbeError, msg=url):
                ffprobe.check_host_allowed(url, resolver=_resolver("127.0.0.1"))

    def test_hostname_resolving_to_private_address_is_refused(self):
        with self.assertRaises(ffprobe.ProbeError) as ctx:
            ffprobe.check_host_allowed("https://cdn.example.com/seg.m4v", resolver=_resolver("10.1.2.3"))
        self.assertNotIn("seg.m4v", str(ctx.exception))

    def test_public_host_is_allowed(self):
        ffprobe.check_host_allowed("https://dash.akamaized.net/a.m4v", resolver=_resolver("93.184.216.34"))

    def test_unresolvable_host_is_refused(self):
        def fail(host, port):
            raise OSError("no such host")
        with self.assertRaises(ffprobe.ProbeError):
            ffprobe.check_host_allowed("https://nope.invalid/a", resolver=fail)

    def test_allow_private_skips_the_check(self):
        ffprobe.check_host_allowed("http://127.0.0.1:1/x", allow_private=True,
                                   resolver=_resolver("127.0.0.1"))


class DownloadGuardTest(unittest.TestCase):

    def test_download_refused_before_any_connection(self):
        opener = ffprobe.build_opener()  # default: private addresses refused
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ffprobe.ProbeError):
                ffprobe.download_range("http://127.0.0.1:9/seg", 0, -1, os.path.join(d, "out"), opener)
            self.assertFalse(os.path.exists(os.path.join(d, "out")))

    def test_redirect_hop_to_private_address_is_refused(self):
        handler = ffprobe._HttpOnlyRedirectHandler(allow_private=False)
        orig = ffprobe.check_host_allowed

        def guarded(url, **kw):
            return orig(url, resolver=_resolver("192.168.0.9"), **kw)
        ffprobe.check_host_allowed = guarded
        try:
            with self.assertRaises(ffprobe.ProbeError):
                handler.redirect_request(None, None, 302, "Found", {}, "http://intranet.example/x")
        finally:
            ffprobe.check_host_allowed = orig

    def test_bridge_default_opener_refuses_private(self):
        self.assertFalse(ffprobe.build_opener().allow_private)


if __name__ == "__main__":
    unittest.main()
