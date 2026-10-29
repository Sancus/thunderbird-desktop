# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Linux-only owned descendants; run in a dedicated, single-threaded process."""

import ctypes
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def descendants():
    records = {}
    for entry in Path("/proc").iterdir():
        if entry.name.isdecimal():
            try:
                fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                records[int(entry.name)] = (int(fields[1]), fields[0])
            except (FileNotFoundError, ProcessLookupError):
                continue
    owned = {os.getpid()}
    while True:
        added = {pid for pid, (parent, _) in records.items() if parent in owned} - owned
        if not added:
            return {pid for pid in owned - {os.getpid()} if records[pid][1] != "Z"}
        owned.update(added)


def initialize():
    if sys.platform != "linux":
        raise ValueError("Windows held: owned Job Object/launcher path not implemented")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise ValueError("Linux pidfd support required")
    if descendants():
        raise ValueError("dedicated runner must start without children")
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError("PR_SET_CHILD_SUBREAPER failed")


def cleanup(deadline):
    terminated = set()
    for sig in (signal.SIGTERM, signal.SIGKILL):
        until = min(deadline, time.monotonic() + 1)
        while descendants() and time.monotonic() < until:
            for pid in descendants():
                try:
                    fd = os.pidfd_open(pid)
                    try:
                        if pid in descendants():
                            signal.pidfd_send_signal(fd, sig)
                            terminated.add(pid)
                    finally:
                        os.close(fd)
                except ProcessLookupError:
                    pass
            time.sleep(0.02)
    survivors = sorted(descendants())
    return {"terminated_pids": sorted(terminated), "survivor_pids": survivors}


def loaded_files(pid, app, library):
    """Observe the actual executable and mapped library, including inode identity."""
    try:
        if not os.path.samefile(f"/proc/{pid}/exe", app):
            return None
        maps = Path(f"/proc/{pid}/maps").read_text()
        wanted = library.stat()
        found = False
        for line in maps.splitlines():
            fields = line.split(maxsplit=5)
            if len(fields) == 6 and Path(fields[5].removesuffix(" (deleted)")).name == library.name:
                major, minor = (int(v, 16) for v in fields[3].split(":"))
                if fields[5] != str(library.resolve()) or (int(fields[4]), major, minor) != (
                    wanted.st_ino, os.major(wanted.st_dev), os.minor(wanted.st_dev)
                ):
                    raise ValueError("different libxul image mapping: " + line)
                found = True
        if found:
            return {"pid": pid, "app": str(app.resolve()), "maps": maps,
                    "library": str(library.resolve()), "inode": wanted.st_ino}
    except (FileNotFoundError, ProcessLookupError):
        pass
    return None


def capture(argv, env, cwd, output, timeout, deadline, app, library):
    initialize()
    record = {"exit_code": None, "timed_out": False, "loaded": None}
    proc = None
    try:
        with (output / "stdout.log").open("xb") as out, (output / "stderr.log").open("xb") as err:
            proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out, stderr=err,
                                    start_new_session=True)
            record["pid"] = proc.pid
            until = min(deadline - 3, time.monotonic() + timeout)
            while proc.poll() is None:
                loaded = loaded_files(proc.pid, app, library)
                if loaded:
                    record["loaded"] = loaded
                if time.monotonic() >= until:
                    record["timed_out"] = True
                    break
                time.sleep(0.01)
            record["exit_code"] = proc.poll()
    except BaseException as error:
        record["process_error"] = str(error)
        raise
    finally:
        try:
            record.update(cleanup(deadline))
            if proc is not None:
                record["exit_code"] = proc.wait(timeout=max(0.1, deadline - time.monotonic()))
            while True:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0:
                        break
                except ChildProcessError:
                    break
        except Exception as error:
            record.update(cleanup_failed=True, cleanup_error=str(error))
        with (output / "process.json").open("x", encoding="utf-8") as stream:
            json.dump(record, stream, indent=2)
    return record
