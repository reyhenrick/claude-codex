import argparse
import base64
from contextlib import contextmanager
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import threading
import unicodedata


class BundleError(RuntimeError):
    pass


def command(arguments, timeout=30):
    try:
        return subprocess.run(arguments, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BundleError("Application operation could not be confirmed") from error


def checked_path(value):
    path = Path(os.path.abspath(value))
    for parent in [*reversed(path.parents), path]:
        try:
            info = parent.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise BundleError("Application paths cannot traverse symbolic links")
    return path


def identity(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise BundleError("Application directory ownership is invalid")
    return [info.st_dev, info.st_ino, info.st_uid]


def read_info(path):
    with (path / "Contents/Info.plist").open("rb") as source:
        return plistlib.load(source)


def reference_info(path):
    path = checked_path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise BundleError("Reference configuration ownership is invalid")
    with path.open("rb") as source:
        value = plistlib.load(source)
    key = value.get("SUPublicEDKey", "")
    try:
        valid = len(base64.b64decode(key, validate=True)) == 32
    except (ValueError, TypeError):
        valid = False
    if not valid or not isinstance(value.get("CFBundleIdentifier"), str):
        raise BundleError("Reference application identity is invalid")
    return value


def codesign(path):
    if command(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--all-architectures", str(path)]).returncode:
        raise BundleError("Application signature validation failed")


def in_use(path):
    result = command(["/usr/sbin/lsof", "-nP", "+D", str(path)], timeout=15)
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise BundleError("Application use could not be checked")
    if result.stdout.strip():
        return True
    processes = command(["/bin/ps", "-axo", "pid=,comm="])
    if processes.returncode:
        raise BundleError("Application processes could not be checked")
    prefix = str(path) + "/"
    return any(len(fields := line.strip().split(None, 1)) == 2 and fields[1].startswith(prefix)
               for line in processes.stdout.splitlines())


def register(path, registered):
    executable = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    if command([executable, "-f" if registered else "-u", str(path)]).returncode:
        if not registered and str(path.resolve()) not in registered_paths(read_info(path)["CFBundleIdentifier"]):
            return
        raise BundleError("Application registration could not be confirmed")


def registered_paths(identifier):
    foundation = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    services = ctypes.CDLL("/System/Library/Frameworks/CoreServices.framework/CoreServices")
    foundation.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    foundation.CFStringCreateWithCString.restype = ctypes.c_void_p
    foundation.CFRelease.argtypes = [ctypes.c_void_p]
    foundation.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    foundation.CFArrayGetCount.restype = ctypes.c_long
    foundation.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
    foundation.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    foundation.CFURLGetFileSystemRepresentation.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_void_p, ctypes.c_long]
    foundation.CFURLGetFileSystemRepresentation.restype = ctypes.c_ubyte
    foundation.CFErrorGetCode.argtypes = [ctypes.c_void_p]
    foundation.CFErrorGetCode.restype = ctypes.c_long
    services.LSCopyApplicationURLsForBundleIdentifier.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    services.LSCopyApplicationURLsForBundleIdentifier.restype = ctypes.c_void_p
    name = foundation.CFStringCreateWithCString(None, identifier.encode(), 0x08000100)
    error = ctypes.c_void_p()
    values = services.LSCopyApplicationURLsForBundleIdentifier(name, ctypes.byref(error))
    try:
        if not values:
            if error.value and foundation.CFErrorGetCode(error) != -10814:
                raise BundleError("Application registrations could not be checked")
            return set()
        paths = set()
        for index in range(foundation.CFArrayGetCount(values)):
            url = foundation.CFArrayGetValueAtIndex(values, index)
            buffer = ctypes.create_string_buffer(4096)
            if not foundation.CFURLGetFileSystemRepresentation(url, True, buffer, len(buffer)):
                raise BundleError("Application registration path could not be checked")
            paths.add(str(Path(os.fsdecode(buffer.value)).resolve()))
        return paths
    finally:
        if values:
            foundation.CFRelease(values)
        if error.value:
            foundation.CFRelease(error)
        if name:
            foundation.CFRelease(name)


def copy_bundle(source, target):
    if command(["/usr/bin/ditto", str(source), str(target)], timeout=120).returncode:
        raise BundleError("Application staging failed")


def atomic_rename(source, target, flags):
    library = ctypes.CDLL(None, use_errno=True)
    rename = library.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(source), os.fsencode(target), flags):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class BundleTransaction:
    def __init__(self, target, reference, validator=None, activity=None, registrar=None,
                 renamer=None, copier=None):
        self.target = checked_path(target)
        if self.target.suffix != ".app" or not self.target.parent.is_dir():
            raise BundleError("The application destination must have an existing parent")
        parent = self.target.parent.stat()
        if parent.st_uid not in (0, os.getuid()) or parent.st_mode & 0o002:
            raise BundleError("Application destination parent is unsafe")
        self.expected = reference_info(reference)
        self.validator = validator or codesign
        self.activity = activity or in_use
        self.registrar = registrar or register
        self.renamer = renamer or atomic_rename
        self.copier = copier or copy_bundle
        tag = hashlib.sha256(unicodedata.normalize("NFD", self.target.name).casefold().encode()).hexdigest()[:16]
        self.directory = self.target.parent / (".app-replacement-" + tag)
        self.slot = self.directory / "candidate.app"
        self.journal = self.directory / "record.json"
        self.lock_path = self.target.parent / (".app-replacement-" + tag + ".lock")
        self.descriptor = None
        self.depth = 0
        self.mutex = threading.RLock()

    @property
    def pending(self):
        with self.locked():
            return self.load() is not None

    @contextmanager
    def locked(self):
        with self.mutex:
            with self._locked():
                yield self

    @contextmanager
    def _locked(self):
        if self.depth:
            self.depth += 1
            try:
                yield self
            finally:
                self.depth -= 1
            return
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise BundleError("Replacement lock ownership is invalid")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise BundleError("Another application replacement is in progress") from error
            current = self.lock_path.lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise BundleError("Replacement lock changed")
            self.descriptor = descriptor
            self.depth = 1
            yield self
        finally:
            self.depth = 0
            self.descriptor = None
            os.close(descriptor)

    def validate(self, path):
        checked_path(path)
        current = identity(path)
        info = read_info(path)
        for key in ["CFBundleIdentifier", "SUPublicEDKey"]:
            if info.get(key) != self.expected.get(key):
                raise BundleError("Application identity does not match the trusted reference")
        self.validator(path)
        if identity(path) != current:
            raise BundleError("Application changed during validation")
        return current

    def idle(self, path):
        current = identity(path)
        if self.activity(path) is not False:
            raise BundleError("Application is in use; replacement was deferred")
        if identity(path) != current:
            raise BundleError("Application changed during its use check")

    def record(self, value):
        temporary = self.directory / "record.tmp"
        payload = (json.dumps(value, sort_keys=True) + "\n").encode()
        descriptor = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        def validate_temporary():
            info = os.fstat(descriptor)
            current = temporary.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                    or info.st_mode & 0o777 != 0o600 or not stat.S_ISREG(current.st_mode)
                    or (current.st_dev, current.st_ino, current.st_uid, current.st_nlink, current.st_mode & 0o777)
                    != (info.st_dev, info.st_ino, info.st_uid, 1, 0o600)):
                raise BundleError("Replacement journal ownership is invalid")
            return info
        try:
            validate_temporary()
            os.ftruncate(descriptor, 0)
            with os.fdopen(descriptor, "wb", closefd=False) as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(descriptor)
            info = validate_temporary()
            os.replace(temporary, self.journal)
            current = self.journal.lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise BundleError("Replacement journal changed during publication")
            sync_directory(self.directory)
        finally:
            os.close(descriptor)

    def load(self):
        with self.locked():
            return self._load()

    def _load(self):
        if not self.directory.exists() and not self.directory.is_symlink():
            return None
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise BundleError("Replacement recovery directory is unsafe")
        entries = set(p.name for p in self.directory.iterdir())
        if not entries:
            current = self.directory.lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise BundleError("Replacement recovery directory changed")
            self.directory.rmdir()
            sync_directory(self.target.parent)
            return None
        if entries - {"candidate.app", "record.json", "record.tmp"}:
            raise BundleError("Unexpected replacement recovery contents")
        try:
            info = self.journal.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise BundleError("Replacement journal is unsafe")
            value = json.loads(self.journal.read_text())
        except (FileNotFoundError, ValueError) as error:
            raise BundleError("Incomplete replacement recovery was preserved") from error
        if (value.get("version") != 1 or value.get("target") != str(self.target)
                or value.get("bundle_id") != self.expected["CFBundleIdentifier"]
                or value.get("public_key") != self.expected["SUPublicEDKey"]
                or not isinstance(value.get("new"), list) or len(value["new"]) != 3
                or value.get("old") is not None and (not isinstance(value["old"], list) or len(value["old"]) != 3)):
            raise BundleError("Replacement recovery identity is invalid")
        return value

    def match(self, path, expected):
        if expected is None:
            return not path.exists() and not path.is_symlink()
        return path.exists() and identity(path) == expected

    def remove_directory(self):
        paths = []
        for name in ["record.tmp", "record.json"]:
            path = self.directory / name
            if path.exists():
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                    raise BundleError("Replacement recovery changed")
                paths.append(path)
        for path in paths:
            path.unlink()
        self.directory.rmdir()
        sync_directory(self.target.parent)

    def commit(self, unregister_target=False):
        with self.locked():
            value = self.load()
            if value is None:
                self.validate(self.target)
                return
            retired_absent = value.get("committed") and not self.slot.exists()
            if not self.match(self.target, value["new"]) or not (self.match(self.slot, value["old"]) or retired_absent):
                raise BundleError("Replacement identities changed; recovery was preserved")
            self.validate(self.target)
            if value["old"] is not None and not retired_absent:
                self.idle(self.slot)
            value["committed"] = True
            self.record(value)
            self.registrar(self.target, not unregister_target)
            if not self.match(self.target, value["new"]):
                raise BundleError("Published application changed; recovery was preserved")
            if value["old"] is not None and not retired_absent:
                if not value.get("unregistered"):
                    self.registrar(self.slot, False)
                    value["unregistered"] = True
                    self.record(value)
                if not self.match(self.slot, value["old"]) or not self.match(self.target, value["new"]):
                    raise BundleError("Retired application changed; recovery was preserved")
                self.idle(self.slot)
                self.validate(self.target)
                if not self.match(self.target, value["new"]):
                    raise BundleError("Published application changed; recovery was preserved")
                shutil.rmtree(self.slot)
            self.remove_directory()

    def rollback(self):
        with self.locked():
            value = self.load()
            if value is None:
                return
            if value.get("committed"):
                raise BundleError("A committed replacement cannot be rolled back")
            if value.get("rolled_back") and self.match(self.target, value["old"]) and not self.slot.exists():
                self.remove_directory()
                return
            if self.match(self.target, value["new"]) and self.match(self.slot, value["old"]):
                self.idle(self.target)
                if value["old"] is None:
                    self.renamer(self.target, self.slot, 4)
                else:
                    self.validate(self.slot)
                    self.renamer(self.target, self.slot, 2)
                sync_directory(self.target.parent)
                sync_directory(self.directory)
            if not self.match(self.target, value["old"]) or not self.match(self.slot, value["new"]):
                raise BundleError("Rollback identity changed; recovery was preserved")
            if value["old"] is not None:
                self.validate(self.target)
                self.registrar(self.target, True)
            self.idle(self.slot)
            if not value.get("unregistered"):
                if (not value.get("preparing") or self.registrar is not register
                        or str(self.slot.resolve()) in registered_paths(self.expected["CFBundleIdentifier"])):
                    self.registrar(self.slot, False)
                value["unregistered"] = True
            value["rolled_back"] = True
            self.record(value)
            if not self.match(self.slot, value["new"]) or not self.match(self.target, value["old"]):
                raise BundleError("Rollback candidate changed; recovery was preserved")
            shutil.rmtree(self.slot)
            self.remove_directory()

    def replace(self, source, defer_cleanup=False, unregister_target=False):
        source = checked_path(source)
        if source == self.target or source.is_relative_to(self.target) or self.target.is_relative_to(source):
            raise BundleError("Application source and destination overlap")
        with self.locked():
            pending = self.load()
            if pending is not None:
                if pending.get("committed"):
                    self.commit(unregister_target=unregister_target)
                else:
                    self.rollback()
            new_source = self.validate(source)
            old = self.validate(self.target) if self.target.exists() else None
            if old == new_source:
                raise BundleError("Application source and destination alias each other")
            if old is not None:
                self.idle(self.target)
            self.directory.mkdir(mode=0o700)
            self.slot.mkdir(mode=0o700)
            new = identity(self.slot)
            value = {"version": 1, "target": str(self.target), "bundle_id": self.expected["CFBundleIdentifier"],
                     "public_key": self.expected["SUPublicEDKey"], "new": new, "old": old, "committed": False,
                     "preparing": True}
            self.record(value)
            try:
                self.copier(source, self.slot)
                if identity(source) != new_source or not self.match(self.slot, new):
                    raise BundleError("Application source or staging changed while copying")
                self.validate(self.slot)
                value["preparing"] = False
                self.record(value)
                if not self.match(self.target, old):
                    raise BundleError("Destination changed before publication")
                self.renamer(self.slot, self.target, 2 if old is not None else 4)
                sync_directory(self.target.parent)
                sync_directory(self.directory)
                if not self.match(self.target, new) or not self.match(self.slot, old):
                    raise BundleError("Publication identities changed")
                self.validate(self.target)
            except Exception:
                self.rollback()
                raise
            if not defer_cleanup:
                self.commit(unregister_target=unregister_target)


def retire(path, reference, replacement, **options):
    path, replacement = checked_path(path), checked_path(replacement)
    if path == replacement or path.is_relative_to(replacement) or replacement.is_relative_to(path):
        raise BundleError("Retired and current applications overlap")
    transaction = BundleTransaction(path, reference, **options)
    with transaction.locked():
        if transaction.directory.exists():
            raise BundleError("Retired application has pending recovery")
        current = transaction.validate(replacement)
        if not path.exists():
            return
        old = transaction.validate(path)
        if old == current:
            raise BundleError("Retired and current applications alias each other")
        try:
            values = [read_info(item)["CFBundleVersion"] for item in [path, replacement]]
            if not all(isinstance(value, str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", value) for value in values):
                raise ValueError("Invalid build")
            old_build, new_build = [tuple(int(part) for part in value.split(".")) for value in values]
            length = max(len(old_build), len(new_build))
            old_build += (0,) * (length - len(old_build))
            new_build += (0,) * (length - len(new_build))
        except (KeyError, ValueError, AttributeError) as error:
            raise BundleError("Application build identity is invalid") from error
        if old_build > new_build:
            raise BundleError("A newer application cannot be retired")
        transaction.idle(path)
        transaction.registrar(path, False)
        if identity(path) != old or identity(replacement) != current:
            raise BundleError("Retired application changed")
        transaction.idle(path)
        if transaction.validate(replacement) != current or identity(path) != old:
            raise BundleError("Retirement identity changed")
        shutil.rmtree(path)
        sync_directory(path.parent)


def main():
    parser = argparse.ArgumentParser()
    actions = parser.add_subparsers(dest="action", required=True)
    for action in ["replace", "commit", "rollback", "retire"]:
        item = actions.add_parser(action)
        item.add_argument("--reference", required=True)
        item.add_argument("--path" if action == "retire" else "--target", required=True)
        if action == "replace":
            item.add_argument("--source", required=True)
            item.add_argument("--defer-cleanup", action="store_true")
        if action in ["replace", "commit"]:
            item.add_argument("--unregister-target", action="store_true")
        if action == "retire":
            item.add_argument("--replacement", required=True)
    arguments = parser.parse_args()
    try:
        if arguments.action == "retire":
            retire(arguments.path, arguments.reference, arguments.replacement)
        else:
            transaction = BundleTransaction(arguments.target, arguments.reference)
            if arguments.action == "replace":
                transaction.replace(arguments.source, arguments.defer_cleanup, arguments.unregister_target)
            elif arguments.action == "commit":
                transaction.commit(arguments.unregister_target)
            else:
                transaction.rollback()
    except (BundleError, OSError, ValueError) as error:
        print("Application replacement stopped: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
