import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Scripts"))
spec = importlib.util.spec_from_file_location("documentation_app", ROOT / "Scripts/documentation-app.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PreviewCleanupTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(suffix=".noindex")
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name).resolve()
        self.app = self.root / "Preview.app"
        (self.app / "Contents").mkdir(parents=True)
        self.info = self.app / "Contents/Info.plist"
        self.info.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.henrick.claude-codex.documentation"}))
        stat = self.app.lstat()
        self.identity = (stat.st_dev, stat.st_ino, stat.st_uid)

    def test_owned_preview_is_removed_and_capture_is_preserved(self):
        capture = self.root / "panel.png"
        capture.write_bytes(b"synthetic capture")
        commands = []
        self.assertTrue(module.cleanup_preview(self.app, self.identity, lambda args, **kwargs: commands.append(args), activity=lambda path: False))
        self.assertFalse(self.app.exists())
        self.assertEqual(capture.read_bytes(), b"synthetic capture")
        self.assertEqual(commands[0][-2:], ["-u", str(self.app)])

    def test_foreign_bundle_is_preserved(self):
        self.info.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.anthropic.claudefordesktop"}))
        self.assertFalse(module.cleanup_preview(self.app, self.identity, lambda *args, **kwargs: self.fail("Must not unregister a foreign app"), activity=lambda path: False))
        self.assertTrue(self.app.exists())

    def test_replaced_path_is_preserved(self):
        self.app.rename(self.root / "Original.app")
        self.app.mkdir()
        self.assertFalse(module.cleanup_preview(self.app, self.identity, lambda *args, **kwargs: self.fail("Must preserve replaced path"), activity=lambda path: False))
        self.assertTrue(self.app.exists())

    def test_substitution_during_unregistration_is_preserved(self):
        def unregister(*args, **kwargs):
            self.app.rename(self.root / "Original.app")
            self.app.mkdir()
        self.assertFalse(module.cleanup_preview(self.app, self.identity, unregister, activity=lambda path: False))
        self.assertTrue(self.app.exists())

    def test_active_preview_is_preserved_without_unregistration(self):
        self.assertFalse(module.cleanup_preview(self.app, self.identity, lambda *args, **kwargs: self.fail("Must preserve active preview"), activity=lambda path: True))
        self.assertTrue(self.app.exists())

    def test_preview_started_during_unregistration_is_preserved(self):
        checks = iter([False, True])
        self.assertFalse(module.cleanup_preview(self.app, self.identity, lambda *args, **kwargs: None, activity=lambda path: next(checks)))
        self.assertTrue(self.app.exists())

    def test_active_previous_capture_cannot_be_overwritten(self):
        with self.assertRaises(RuntimeError):
            module.ensure_preview_destination(self.app, activity=lambda path: True)
        self.assertTrue(self.info.exists())

    def test_foreign_preview_destination_cannot_be_overwritten(self):
        self.info.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.anthropic.claudefordesktop"}))
        before = self.info.read_bytes()
        with self.assertRaises(RuntimeError):
            module.ensure_preview_destination(self.app, activity=lambda path: False)
        self.assertEqual(self.info.read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
