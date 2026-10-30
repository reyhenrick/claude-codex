import base64
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = "Scripts" if (ROOT / "Scripts").is_dir() else "scripts"
SPEC = importlib.util.spec_from_file_location("app_bundle", ROOT / DIRECTORY / "app_bundle.py")
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


class Interrupted(BaseException):
    pass


@unittest.skipUnless(sys.platform == "darwin", "Native atomic application replacement requires macOS")
class AppBundleTests(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(suffix=".noindex")
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name).resolve()
        self.reference = self.root / "Info.plist"
        self.expected = {"CFBundleIdentifier": "com.example.replacement-test",
                         "SUPublicEDKey": base64.b64encode(b"0" * 32).decode()}
        self.reference.write_bytes(plistlib.dumps(self.expected))
        self.source = self.make_app("source.app", "2", "new")
        self.target = self.make_app("Current App.app", "1", "old")
        self.registrations = []
        self.busy = set()

    def make_app(self, name, build, content, **extra):
        path = self.root / name
        (path / "Contents/MacOS").mkdir(parents=True)
        info = {**self.expected, "CFBundleVersion": build, **extra}
        (path / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        (path / "Contents/MacOS/App").write_text(content)
        return path

    def content(self, path=None):
        return ((path or self.target) / "Contents/MacOS/App").read_text()

    def validator(self, path):
        if self.content(path) == "invalid":
            raise bundle.BundleError("Invalid synthetic signature")

    def transaction(self, **extra):
        values = dict(validator=self.validator, activity=lambda path: path in self.busy,
                      registrar=lambda path, registered: self.registrations.append((path, registered)),
                      copier=lambda source, target: shutil.copytree(source, target, symlinks=True, dirs_exist_ok=True))
        values.update(extra)
        return bundle.BundleTransaction(self.target, self.reference, **values)

    def test_repeated_replacement_uses_atomic_swap_and_removes_retired_bundles(self):
        tx = self.transaction()
        first_inode = bundle.identity(self.target)
        tx.replace(self.source)
        self.assertEqual(self.content(), "new")
        self.assertFalse(tx.directory.exists())
        self.assertNotEqual(bundle.identity(self.target), first_inode)
        lock = tx.lock_path.stat().st_ino
        source = self.make_app("source-next.app", "3", "next")
        tx.replace(source, unregister_target=True)
        self.assertEqual(self.content(), "next")
        self.assertFalse(tx.directory.exists())
        self.assertEqual(tx.lock_path.stat().st_ino, lock)
        self.assertIn((self.target, False), self.registrations)
        self.assertFalse(list(self.root.glob(".app-replacement-*/candidate.app")))

    def test_initial_install_is_exclusive_and_existing_bundle_never_disappears_during_swap(self):
        seen = []
        def rename(source, target, flags):
            if flags == 2:
                self.assertTrue(target.is_dir())
            seen.append(flags)
            bundle.atomic_rename(source, target, flags)
            self.assertTrue(target.is_dir())
        self.transaction(renamer=rename).replace(self.source)
        self.assertEqual(seen, [2])
        shutil.rmtree(self.target)
        self.transaction(renamer=rename).replace(self.source)
        self.assertEqual(seen, [2, 4])

    def test_invalid_source_preserves_old_before_creating_transaction(self):
        for extra, contents in [({"CFBundleIdentifier": "com.example.other"}, "x"),
                                ({"SUPublicEDKey": base64.b64encode(b"1" * 32).decode()}, "x"),
                                ({}, "invalid")]:
            with self.subTest(extra=extra, contents=contents):
                source = self.make_app("bad.app", "2", contents, **extra)
                tx = self.transaction()
                with self.assertRaises(bundle.BundleError):
                    tx.replace(source)
                self.assertEqual(self.content(), "old")
                self.assertFalse(tx.directory.exists())
                shutil.rmtree(source)

    def test_symlinks_and_aliases_are_rejected(self):
        source_link = self.root / "link.app"
        source_link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(bundle.BundleError):
            self.transaction().replace(source_link)
        parent_link = self.root / "parent"
        parent_link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(bundle.BundleError):
            bundle.BundleTransaction(parent_link / "other.app", self.reference)
        with self.assertRaises(bundle.BundleError):
            self.transaction().replace(self.target)
        self.assertEqual(self.content(), "old")

    def test_busy_or_uncertain_use_preserves_target(self):
        for activity in [lambda path: True, lambda path: None, lambda path: (_ for _ in ()).throw(bundle.BundleError("use timeout"))]:
            tx = self.transaction(activity=activity)
            with self.assertRaises(bundle.BundleError):
                tx.replace(self.source)
            self.assertEqual(self.content(), "old")
            self.assertFalse(tx.directory.exists())

    def test_new_canonical_verification_failure_rolls_back(self):
        def validate(path):
            self.validator(path)
            if path == self.target and self.content(path) == "new":
                raise bundle.BundleError("Publication validation failed")
        old = bundle.identity(self.target)
        tx = self.transaction(validator=validate)
        with self.assertRaises(bundle.BundleError):
            tx.replace(self.source)
        self.assertEqual(bundle.identity(self.target), old)
        self.assertEqual(self.content(), "old")
        self.assertFalse(tx.directory.exists())

    def test_failed_rollback_keeps_both_exact_bundles_and_can_be_retried(self):
        calls = 0
        def rename(source, target, flags):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("Synthetic rollback failure")
            bundle.atomic_rename(source, target, flags)
        def validate(path):
            if path == self.target and self.content(path) == "new":
                raise bundle.BundleError("Synthetic published failure")
        tx = self.transaction(renamer=rename, validator=validate)
        with self.assertRaises(OSError):
            tx.replace(self.source)
        self.assertTrue(tx.pending)
        self.assertEqual(self.content(tx.slot), "old")
        self.transaction().rollback()
        self.assertEqual(self.content(), "old")
        self.assertFalse(tx.pending)

    def test_crash_before_swap_recovers_without_losing_current_app(self):
        tx = self.transaction(renamer=lambda *arguments: (_ for _ in ()).throw(Interrupted()))
        with self.assertRaises(Interrupted):
            tx.replace(self.source)
        self.assertEqual(self.content(), "old")
        self.assertTrue(tx.pending)
        self.transaction().replace(self.source)
        self.assertEqual(self.content(), "new")
        self.assertFalse(tx.pending)

    def test_interrupted_deferred_install_is_rolled_back_before_a_fresh_replace(self):
        tx = self.transaction()
        tx.replace(self.source, defer_cleanup=True)
        old = tx.load()["old"]
        stages = []
        def copy(source, target):
            stages.append(bundle.identity(self.target))
            shutil.copytree(source, target, dirs_exist_ok=True)
        self.transaction(copier=copy).replace(self.source)
        self.assertEqual(stages, [old])
        self.assertFalse(tx.pending)

    def test_deferred_commit_checks_retired_activity_and_keeps_current_running(self):
        tx = self.transaction()
        tx.replace(self.source, defer_cleanup=True)
        self.busy.add(tx.slot)
        with self.assertRaises(bundle.BundleError):
            tx.commit()
        self.assertEqual(self.content(), "new")
        self.assertTrue(tx.pending)
        self.busy = {self.target}
        tx.commit()
        self.assertFalse(tx.pending)

    def test_committed_cleanup_failure_is_retryable_without_rollback(self):
        tx = self.transaction()
        tx.replace(self.source, defer_cleanup=True)
        with patch.object(bundle.shutil, "rmtree", side_effect=OSError("Synthetic cleanup failure")):
            with self.assertRaises(OSError):
                tx.commit()
        self.assertTrue(tx.load()["committed"])
        with self.assertRaises(bundle.BundleError):
            tx.rollback()
        self.assertEqual(self.content(), "new")
        tx.commit()
        self.assertFalse(tx.pending)

    def test_cleanup_failure_after_retired_deletion_finishes_on_retry(self):
        tx = self.transaction()
        tx.replace(self.source, defer_cleanup=True)
        with patch.object(tx, "remove_directory", side_effect=OSError("Synthetic journal cleanup failure")):
            with self.assertRaises(OSError):
                tx.commit()
        self.assertFalse(tx.slot.exists())
        self.assertTrue(tx.pending)
        self.transaction().commit()
        self.assertFalse(tx.pending)

    def test_registration_failure_preserves_recovery_and_does_not_erase_old(self):
        tx = self.transaction(registrar=lambda *arguments: (_ for _ in ()).throw(bundle.BundleError("registration failed")))
        with self.assertRaises(bundle.BundleError):
            tx.replace(self.source)
        self.assertEqual(self.content(), "new")
        self.assertEqual(self.content(tx.slot), "old")
        self.assertTrue(tx.pending)
        self.transaction().commit()
        self.assertFalse(tx.pending)

    def test_foreign_transaction_contents_are_preserved(self):
        tx = self.transaction()
        tx.replace(self.source, defer_cleanup=True)
        other = tx.directory / "user-file"
        other.write_text("preserve")
        with self.assertRaises(bundle.BundleError):
            tx.commit()
        self.assertEqual(other.read_text(), "preserve")
        self.assertEqual(self.content(tx.slot), "old")

    def test_late_target_substitution_cannot_delete_the_retired_bundle(self):
        def registration(path, registered):
            if path == self.target and registered:
                self.target.rename(self.root / "published-moved.app")
                self.make_app(self.target.name, "9", "foreign")
        tx = self.transaction(registrar=registration)
        with self.assertRaises(bundle.BundleError):
            tx.replace(self.source)
        self.assertEqual(self.content(), "foreign")
        self.assertEqual(self.content(tx.slot), "old")
        self.assertTrue(tx.pending)

    def test_reentrant_lease_excludes_another_replacement(self):
        tx = self.transaction()
        with tx.locked():
            with tx.locked():
                with self.assertRaises(bundle.BundleError):
                    with self.transaction().locked():
                        self.fail("Second lease must not acquire")
            tx.replace(self.source)
        self.assertEqual(self.content(), "new")

    def test_case_aliases_share_the_same_destination_lease(self):
        tx = self.transaction()
        alias = bundle.BundleTransaction(self.target.with_name(self.target.stem.swapcase() + self.target.suffix), self.reference)
        self.assertEqual(tx.lock_path, alias.lock_path)
        with tx.locked():
            with self.assertRaises(bundle.BundleError):
                with alias.locked():
                    self.fail("A case alias must not acquire a second lease")

    def test_retire_cannot_remove_the_replacement_through_a_case_alias(self):
        alias = self.source.with_name(self.source.stem.upper() + self.source.suffix)
        if not alias.exists():
            self.skipTest("The fixture filesystem is case-sensitive")
        self.assertEqual(bundle.identity(alias), bundle.identity(self.source))
        with self.assertRaises(bundle.BundleError):
            bundle.retire(alias, self.reference, self.source, validator=self.validator,
                          activity=lambda path: False,
                          registrar=lambda path, registered: self.registrations.append((path, registered)))
        self.assertEqual(self.content(self.source), "new")
        self.assertEqual(self.content(), "old")
        self.assertEqual(self.registrations, [])

    def test_empty_transaction_after_final_rmdir_failure_or_crash_is_recoverable(self):
        actual_rmdir = Path.rmdir
        for error in [OSError("Synthetic final rmdir failure"), Interrupted()]:
            with self.subTest(error=type(error).__name__):
                tx = self.transaction()
                tx.replace(self.source, defer_cleanup=True)
                def fail_final_rmdir(path):
                    if path == tx.directory:
                        raise error
                    return actual_rmdir(path)
                with patch.object(Path, "rmdir", fail_final_rmdir):
                    with self.assertRaises(type(error)):
                        tx.commit()
                self.assertEqual(self.content(), "new")
                self.assertTrue(tx.directory.is_dir())
                self.assertEqual(list(tx.directory.iterdir()), [])
                self.transaction().commit()
                self.assertFalse(tx.directory.exists())
                self.transaction().replace(self.source)
                self.assertEqual(self.content(), "new")

    def test_only_safe_empty_recovery_directory_can_be_removed_without_a_record(self):
        tx = self.transaction()
        tx.directory.mkdir(mode=0o755)
        tx.directory.chmod(0o755)
        with self.assertRaises(bundle.BundleError):
            tx.commit()
        self.assertTrue(tx.directory.exists())
        tx.directory.chmod(0o700)
        retained = tx.directory / "evidence"
        retained.write_text("keep this file")
        with self.assertRaises(bundle.BundleError):
            tx.commit()
        self.assertEqual(retained.read_text(), "keep this file")
        self.assertEqual(self.content(), "old")

    def test_another_process_cannot_acquire_the_replacement_lease(self):
        script = """import importlib.util,sys
spec=importlib.util.spec_from_file_location('bundle',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try:
 with module.BundleTransaction(sys.argv[2],sys.argv[3]).locked(): sys.exit(9)
except module.BundleError: sys.exit(3)
"""
        with self.transaction().locked():
            child = subprocess.Popen([sys.executable, "-c", script, str(ROOT / DIRECTORY / "app_bundle.py"), str(self.target), str(self.reference)])
            print("lease fixture PID", child.pid)
            self.assertEqual(child.wait(timeout=10), 3)

    def test_crash_after_atomic_swap_keeps_a_valid_canonical_and_exact_rollback(self):
        old = bundle.identity(self.target)
        def rename(source, target, flags):
            bundle.atomic_rename(source, target, flags)
            raise Interrupted()
        tx = self.transaction(renamer=rename)
        with self.assertRaises(Interrupted):
            tx.replace(self.source)
        self.assertEqual(self.content(), "new")
        self.assertEqual(bundle.identity(tx.slot), old)
        self.transaction().rollback()
        self.assertEqual(self.content(), "old")

    def test_open_file_in_bundle_is_detected_without_executing_it(self):
        with (self.target / "Contents/MacOS/App").open():
            self.assertTrue(bundle.in_use(self.target))

    def test_failed_staging_is_removed_without_losing_current_and_next_try_succeeds(self):
        def failed_copy(source, target):
            shutil.copytree(source, target, dirs_exist_ok=True)
            raise OSError("Synthetic interrupted staging")
        tx = self.transaction(copier=failed_copy)
        with self.assertRaises(OSError):
            tx.replace(self.source)
        self.assertEqual(self.content(), "old")
        self.assertFalse(tx.directory.exists())
        self.transaction().replace(self.source)
        self.assertEqual(self.content(), "new")

    def test_source_substitution_during_copy_discards_only_our_staging(self):
        moved = self.root / "original-source.app"
        def copy(source, target):
            shutil.copytree(source, target, dirs_exist_ok=True)
            source.rename(moved)
            self.make_app(source.name, "9", "foreign")
        tx = self.transaction(copier=copy)
        with self.assertRaises(bundle.BundleError):
            tx.replace(self.source)
        self.assertEqual(self.content(), "old")
        self.assertEqual(self.content(self.source), "foreign")
        self.assertEqual(self.content(moved), "new")
        self.assertFalse(tx.directory.exists())

    def test_native_ditto_keeps_the_recorded_staging_directory_identity(self):
        tx = self.transaction(copier=bundle.copy_bundle)
        tx.replace(self.source)
        self.assertEqual(self.content(), "new")
        self.assertFalse(tx.pending)

    def test_unregistration_failure_requires_confirmed_registration_absence(self):
        failed = subprocess.CompletedProcess([], 1, "", "synthetic registration failure")
        with patch.object(bundle, "command", return_value=failed):
            with patch.object(bundle, "registered_paths", return_value=set()):
                bundle.register(self.target, False)
            with patch.object(bundle, "registered_paths", return_value={str(self.target.resolve())}):
                with self.assertRaises(bundle.BundleError):
                    bundle.register(self.target, False)
            with patch.object(bundle, "registered_paths", side_effect=bundle.BundleError("Unknown registration state")):
                with self.assertRaises(bundle.BundleError):
                    bundle.register(self.target, False)

    def test_staged_validation_failure_cleans_recorded_candidate_and_can_retry(self):
        def copy(source, target):
            shutil.copytree(source, target, dirs_exist_ok=True)
            (target / "Contents/MacOS/App").write_text("invalid")
        tx = self.transaction(copier=copy)
        with self.assertRaises(bundle.BundleError):
            tx.replace(self.source)
        self.assertEqual(self.content(), "old")
        self.assertFalse(tx.directory.exists())
        self.transaction().replace(self.source)
        self.assertEqual(self.content(), "new")

    def test_crash_during_copy_keeps_a_recoverable_candidate_record(self):
        def copy(source, target):
            shutil.copytree(source, target, dirs_exist_ok=True)
            raise Interrupted()
        tx = self.transaction(copier=copy)
        with self.assertRaises(Interrupted):
            tx.replace(self.source)
        self.assertEqual(self.content(), "old")
        self.assertTrue(tx.pending)
        self.assertTrue(tx.load()["preparing"])
        self.transaction().replace(self.source)
        self.assertEqual(self.content(), "new")
        self.assertFalse(tx.pending)

    def test_retire_removes_only_older_idle_exact_bundle(self):
        tx = self.transaction()
        options = dict(validator=self.validator, activity=lambda path: path in self.busy,
                       registrar=lambda *arguments: None)
        bundle.retire(self.target, self.reference, self.source, **options)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.content(self.source), "new")
        self.target = self.make_app("Current App.app", "3", "newer")
        with self.assertRaises(bundle.BundleError):
            bundle.retire(self.target, self.reference, self.source, **options)
        self.busy.add(self.source)
        with self.assertRaises(bundle.BundleError):
            bundle.retire(self.source, self.reference, self.source, **options)
        self.assertTrue(self.target.exists())

    def test_unsafe_lock_and_journal_are_rejected(self):
        tx = self.transaction()
        tx.lock_path.symlink_to(self.reference)
        with self.assertRaises(OSError):
            tx.replace(self.source)
        tx.lock_path.unlink()
        tx.replace(self.source, defer_cleanup=True)
        tx.journal.chmod(0o644)
        with self.assertRaises(bundle.BundleError):
            tx.commit()
        self.assertEqual(self.content(tx.slot), "old")

    def test_hardlinked_journal_temporary_cannot_truncate_an_external_file(self):
        sentinel = self.root / "external-sentinel"
        sentinel.write_bytes(b"outside bytes must stay intact\n")
        sentinel.chmod(0o600)
        def copy(source, target):
            shutil.copytree(source, target, dirs_exist_ok=True)
            os.link(sentinel, target.parent / "record.tmp")
        tx = self.transaction(copier=copy)
        with self.assertRaises(bundle.BundleError):
            tx.replace(self.source)
        self.assertEqual(sentinel.read_bytes(), b"outside bytes must stay intact\n")
        self.assertEqual(self.content(), "old")
        self.assertEqual(self.content(self.source), "new")
        self.assertTrue(tx.directory.exists())

    def test_unsafe_journal_temporary_mode_is_rejected_before_truncation(self):
        tx = self.transaction()
        tx.directory.mkdir(mode=0o700)
        temporary = tx.directory / "record.tmp"
        for mode in [0o644, 0o666]:
            temporary.write_bytes(b"preserve existing contents")
            temporary.chmod(mode)
            with self.assertRaises(bundle.BundleError):
                tx.record({"probe": True})
            self.assertEqual(temporary.read_bytes(), b"preserve existing contents")
        self.assertEqual(self.content(), "old")
        self.assertEqual(self.content(self.source), "new")

    def test_fifo_journal_temporary_cannot_block_the_writer(self):
        tx = self.transaction()
        tx.directory.mkdir(mode=0o700)
        temporary = tx.directory / "record.tmp"
        os.mkfifo(temporary, 0o600)
        script = """import importlib.util,sys
spec=importlib.util.spec_from_file_location('bundle',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try: module.BundleTransaction(sys.argv[2],sys.argv[3]).record({'probe':True})
except module.BundleError: sys.exit(3)
sys.exit(9)
"""
        child = subprocess.Popen([sys.executable, "-c", script, str(ROOT / DIRECTORY / "app_bundle.py"), str(self.target), str(self.reference)])
        print("FIFO fixture PID", child.pid)
        try:
            self.assertEqual(child.wait(timeout=3), 3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
            self.fail("FIFO journal must not block the replacement writer")
        self.assertTrue(stat.S_ISFIFO(temporary.lstat().st_mode))
        self.assertEqual(self.content(), "old")
        self.assertEqual(self.content(self.source), "new")

    def test_journal_temporary_path_substitution_is_rejected_before_truncation(self):
        tx = self.transaction()
        tx.directory.mkdir(mode=0o700)
        temporary = tx.directory / "record.tmp"
        temporary.write_bytes(b"original temporary")
        temporary.chmod(0o600)
        moved = self.root / "original-temporary"
        actual_open = os.open
        def changed_open(path, flags, mode=0o777, **options):
            descriptor = actual_open(path, flags, mode, **options)
            if Path(path) == temporary:
                temporary.rename(moved)
                temporary.write_bytes(b"foreign temporary")
                temporary.chmod(0o600)
            return descriptor
        with patch.object(bundle.os, "open", side_effect=changed_open):
            with self.assertRaises(bundle.BundleError):
                tx.record({"probe": True})
        self.assertEqual(moved.read_bytes(), b"original temporary")
        self.assertEqual(temporary.read_bytes(), b"foreign temporary")


if __name__ == "__main__":
    unittest.main(verbosity=2)
