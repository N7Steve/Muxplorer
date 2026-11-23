"""Safety boundaries for local Muxplorer releases; no network, Docker or credentials."""
import contextlib
import email.message
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import urllib.error
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release_local", Path(__file__).parents[1] / "release-local.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def http_error(url, code, headers=None):
    hdrs = email.message.Message()
    for key, value in (headers or {}).items():
        hdrs[key] = value
    return urllib.error.HTTPError(url, code, "Error", hdrs, None)


class LocalReleaseTests(unittest.TestCase):
    def test_private_image_must_explicitly_reject_anonymous_access(self):
        image = f"{release.IMAGE}:test"
        challenge = {
            "WWW-Authenticate": 'Bearer realm="http://100.81.25.109:30008/v2/token",service="container_registry",scope="repository:n7steve/muxplorer:pull"'
        }
        with patch.object(
            release.urllib.request,
            "urlopen",
            side_effect=[
                http_error("http://100.81.25.109:30008/v2/", 401, challenge),
                http_error("http://100.81.25.109:30008/v2/token", 401),
            ],
        ):
            release.verify_private_image(image)
        with patch.object(
            release.urllib.request,
            "urlopen",
            side_effect=[
                http_error("http://100.81.25.109:30008/v2/", 401, challenge),
                io.BytesIO(b'{"token":"anonymous-token"}'),
                io.BytesIO(b"{}"),
            ],
        ):
            with self.assertRaisesRegex(RuntimeError, "sin autenticar"):
                release.verify_private_image(image)
        with patch.object(release.urllib.request, "urlopen", side_effect=urllib.error.URLError("timed out")):
            with self.assertRaisesRegex(RuntimeError, "No se ha podido verificar"):
                release.verify_private_image(image)

    def test_dirty_tree_cannot_be_prepared(self):
        with patch.object(release, "git", side_effect=["main", " M file"]):
            with self.assertRaisesRegex(RuntimeError, "sin commit"):
                release.require_source()

    def test_preview_cannot_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            release.write_json(folder / "prepared.json", {"preview": True})
            with patch.object(release, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "preview"):
                    release.publish(folder)
                run.assert_not_called()

    def test_remote_main_must_match_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            release.write_json(folder / "prepared.json", {"preview": False, "commit": "a" * 40, "version": "0.1.6"})
            with patch.object(release, "require_source", return_value="a" * 40), \
                 patch.object(release, "git", return_value="b" * 40 + "\trefs/heads/main"), \
                 patch.object(release, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Sube primero"):
                    release.publish(folder)
                run.assert_not_called()

    def test_publish_order_checks_privacy_before_version_and_latest(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            release.write_json(folder / "prepared.json", {
                "preview": False, "commit": "a" * 40, "version": "0.1.6",
                "image": "muxplorer-local:test", "imageId": "sha256:image",
            })
            events = []
            def command(*args, **kwargs):
                events.append(args)
                if args[:3] == ("docker", "image", "inspect"):
                    return json.dumps([{"Id": "sha256:image", "RepoDigests": [f"{release.IMAGE}@sha256:{'b' * 64}"]}])
                return ""
            def privacy(target):
                events.append(("verify_private_image", target))
            with patch.object(release, "require_source", return_value="a" * 40), \
                 patch.object(release, "git", return_value="a" * 40 + "\trefs/heads/main"), \
                 patch.object(release, "app_version", return_value="0.1.6"), \
                 patch.object(release, "verify_private_image", side_effect=privacy), \
                 patch.object(release, "run", side_effect=command):
                with contextlib.redirect_stdout(io.StringIO()):
                    release.publish(folder)
            sha_push = events.index(("docker", "push", f"{release.IMAGE}:sha-{'a' * 40}"))
            privacy_idx = events.index(("verify_private_image", f"{release.IMAGE}:sha-{'a' * 40}"))
            ver_push = events.index(("docker", "push", f"{release.IMAGE}:0.1.6"))
            latest_push = events.index(("docker", "push", f"{release.IMAGE}:latest"))
            self.assertLess(sha_push, privacy_idx)
            self.assertLess(privacy_idx, ver_push)
            self.assertLess(ver_push, latest_push)


if __name__ == "__main__":
    unittest.main()
