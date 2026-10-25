# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Win32 ownership probes with tiny Python programs, never Thunderbird."""

from contextlib import chdir
import ctypes as C
from ctypes import wintypes as W
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import native_windows as windows

def child_env():
    return {k: os.environ[k] for k in ("SystemRoot", "WINDIR", "TEMP", "TMP") if k in os.environ}


TREE = r'''
import json, os, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"],
                         creationflags=subprocess.CREATE_NO_WINDOW)
Path(sys.argv[1]).write_text(json.dumps([os.getpid(), child.pid]))
if sys.argv[2] == "exit":
    sys.exit(7)
time.sleep(20)
'''


@unittest.skipUnless(sys.platform == "win32", "real Win32 helper probes require Windows")
class WindowsJobTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        windows.initialize()

    def launch(self, job, code, *args, cancel=lambda: None):
        return job.launch([sys.executable, "-c", code, *map(str, args)], child_env(),
                          self.root, self.root / "stdout.log", self.root / "stderr.log", cancel)

    def ready(self, path):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            try:
                return json.loads(path.read_text())
            except (OSError, ValueError):
                time.sleep(0.01)
        self.fail("tiny fixture did not publish its process IDs")

    def probe(self, pid):
        handle = windows.checked(windows.api.OpenProcess(0x100000, False, pid))
        self.addCleanup(lambda: windows.checked(windows.api.CloseHandle(handle)))
        return handle

    def assert_exited(self, handle):
        self.assertEqual(windows.api.WaitForSingleObject(handle, 2000), 0)

    def test_exit_code_and_unfiltered_streams(self):
        with windows.Job() as job:
            pid = self.launch(job, "import sys; print('raw stdout'); print('raw stderr',file=sys.stderr); sys.exit(7)")
            self.assertEqual(job.wait(time.monotonic()+3), 7)
            self.assertEqual(job.pids(), [])
            self.assertEqual(job.request["pid"], pid)
            self.assertIn("CREATE_SUSPENDED", job.request["flags"])
        self.assertEqual((self.root / "stdout.log").read_text().strip(), "raw stdout")
        self.assertEqual((self.root / "stderr.log").read_text().strip(), "raw stderr")

    def test_assignment_precedes_execution_and_failure_never_resumes(self):
        marker = self.root / "ran"
        with windows.Job() as job:
            handles = []
            def denied(job_handle, process_handle):
                handles.append(self.probe(job.pid))
                self.assertFalse(marker.exists())
                C.set_last_error(5)
                return False
            with (patch.object(windows.api, "AssignProcessToJobObject", denied),
                  patch.object(windows.api, "ResumeThread", wraps=windows.api.ResumeThread) as resume):
                with self.assertRaises(OSError) as error:
                    self.launch(job, "from pathlib import Path; Path('ran').write_text('bad')")
                self.assertEqual(error.exception.winerror, 5)
                resume.assert_not_called()
            self.assert_exited(handles[0])
        self.assertFalse(marker.exists())

    def test_cancel_after_assignment_never_resumes_and_closes_process(self):
        calls, handles = [], []
        with windows.Job() as job:
            def cancel():
                calls.append(True)
                if len(calls) == 2:
                    self.assertIn(job.pid, job.pids())
                    handles.append(self.probe(job.pid))
                    raise InterruptedError("fixture cancellation")
            with patch.object(windows.api, "ResumeThread", wraps=windows.api.ResumeThread) as resume:
                with self.assertRaisesRegex(InterruptedError, "fixture cancellation"):
                    self.launch(job, "from pathlib import Path; Path('ran').write_text('bad')", cancel=cancel)
                resume.assert_not_called()
            self.assert_exited(handles[0])
        self.assertFalse((self.root / "ran").exists())

    def test_resume_failure_terminates_the_assigned_suspended_process(self):
        handles = []
        with windows.Job() as job:
            def failed_resume(thread):
                handles.append(self.probe(job.pid))
                C.set_last_error(5)
                return 0xFFFFFFFF
            with patch.object(windows.api, "ResumeThread", failed_resume):
                with self.assertRaises(OSError):
                    self.launch(job, "from pathlib import Path; Path('ran').write_text('bad')")
            self.assert_exited(handles[0])
        self.assertFalse((self.root / "ran").exists())

    def test_parent_exit_does_not_complete_a_live_owned_grandchild(self):
        marker = self.root / "ids.json"
        with windows.Job() as job:
            self.launch(job, TREE, marker, "exit")
            parent, child = self.ready(marker)
            child_handle = self.probe(child)
            self.assertIn(child, job.pids())
            self.assertEqual(windows.api.WaitForSingleObject(child_handle, 0), 258)
            with self.assertRaises(TimeoutError):
                job.wait(time.monotonic()+0.1)
            until = time.monotonic()+3
            while job.root_exit_code() is None and time.monotonic() < until:
                time.sleep(0.01)
            self.assertEqual(job.root_exit_code(), 7)
        self.assert_exited(child_handle)

    def test_cancel_wait_cleans_tree_without_terminating_unrelated_process(self):
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"],
                                 creationflags=subprocess.CREATE_NO_WINDOW, env=child_env())
        self.addCleanup(lambda: self.stop_other(other))
        with windows.Job() as job:
            self.launch(job, TREE, self.root / "ids.json", "stay")
            handles = [self.probe(pid) for pid in self.ready(self.root / "ids.json")]
            def cancel():
                raise InterruptedError("wait cancelled")
            with self.assertRaisesRegex(InterruptedError, "wait cancelled"):
                job.wait(time.monotonic()+1, cancel)
        for handle in handles:
            self.assert_exited(handle)
        self.assertIsNone(other.poll())

    def stop_other(self, process):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=3)

    def test_kill_on_job_close_when_owner_exits_without_cleanup(self):
        worker = r'''
import os, sys, time
from pathlib import Path
import native_windows as w
root = Path(sys.argv[1])
job = w.Job()
job.launch([sys.executable, '-c', "import os,time; from pathlib import Path; Path('child.json').write_text(str(os.getpid())); time.sleep(20)"],
           dict(os.environ), root, root/'out', root/'err')
until = time.monotonic()+4
while not (root/'release').exists() and time.monotonic() < until:
    time.sleep(.01)
os._exit(0)
'''
        process = subprocess.Popen([sys.executable, "-B", "-c", worker, str(self.root)],
                                   cwd=Path(windows.__file__).parent, creationflags=subprocess.CREATE_NO_WINDOW,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=child_env())
        self.addCleanup(lambda: self.stop_other(process))
        child = self.probe(self.ready(self.root / "child.json"))
        (self.root / "release").touch()
        self.assertEqual(process.wait(timeout=3), 0)
        self.assert_exited(child)

    def test_loaded_identity_comes_from_owned_process_not_requested_disk_file(self):
        with windows.Job() as job:
            pid = self.launch(job, "import json,os,time; from pathlib import Path; Path('ready').write_text(json.dumps(os.getpid())); time.sleep(20)")
            self.ready(self.root / "ready")
            library = Path(os.environ["SystemRoot"]) / "System32/kernel32.dll"
            proof = job.observe(pid, Path(sys.executable), library)
            self.assertEqual(proof["pid"], pid)
            self.assertTrue(os.path.samefile(proof["image"]["path"], sys.executable))
            self.assertTrue(os.path.samefile(proof["library"]["path"], library))
            self.assertTrue(proof["modules"])
            wrong = self.root / "kernel32.dll"
            wrong.write_text("on disk, never loaded")
            with self.assertRaisesRegex(ValueError, "different loaded"):
                job.observe(pid, Path(sys.executable), wrong)
            with self.assertRaisesRegex(ValueError, "executable identity"):
                job.observe(pid, wrong, library)
            with self.assertRaisesRegex(ValueError, "not owned"):
                job.observe(os.getpid(), Path(sys.executable), library)
            def denied(*args):
                C.set_last_error(5)
                return False
            with patch.object(windows.api, "K32EnumProcessModulesEx", denied):
                with self.assertRaises(OSError):
                    job.observe(pid, Path(sys.executable), library)


    def test_create_return_interruption_still_owns_and_terminates_suspended_process(self):
        handles = []
        with windows.Job() as job:
            create = windows.api.CreateProcessW
            def interrupted(*args):
                result = create(*args)
                windows.checked(result)
                handles.append(self.probe(job.pid))
                raise InterruptedError("after native CreateProcessW returned")
            with (patch.object(windows.api, "CreateProcessW", interrupted),
                  patch.object(windows.api, "ResumeThread", wraps=windows.api.ResumeThread) as resume):
                with self.assertRaisesRegex(InterruptedError, "after native CreateProcessW"):
                    self.launch(job, "from pathlib import Path; Path('ran').write_text('bad')")
                resume.assert_not_called()
            self.assert_exited(handles[0])
        self.assertFalse((self.root / "ran").exists())

    def test_query_permission_error_is_not_an_empty_job_and_closed_job_cannot_observe(self):
        job = windows.Job()
        try:
            def denied(*args):
                C.set_last_error(5)
                return False
            with patch.object(windows.api, "QueryInformationJobObject", denied):
                with self.assertRaises(OSError):
                    job.pids()
        finally:
            job.close(time.monotonic()+2)
        with self.assertRaisesRegex(ValueError, "closed"):
            job.observe(os.getpid(), Path(sys.executable), Path("unused.dll"))

    def test_job_id_query_retries_insufficient_capacity(self):
        with windows.Job() as job:
            query = windows.api.QueryInformationJobObject
            calls = []
            def more_data(*args):
                calls.append(args[3])
                if len(calls) == 1:
                    C.set_last_error(234)
                    return False
                return query(*args)
            with patch.object(windows.api, "QueryInformationJobObject", more_data):
                self.assertEqual(job.pids(), [])
            self.assertEqual(len(calls), 2)
            self.assertGreater(calls[1], calls[0])


    def test_cleanup_interruption_retries_and_preserves_terminated_pid_evidence(self):
        with windows.Job() as job:
            pid = self.launch(job, "import time; time.sleep(20)")
            process = self.probe(pid)
            terminate = windows.api.TerminateJobObject
            calls = []
            def interrupted(*args):
                calls.append(True)
                result = terminate(*args)
                if len(calls) == 1:
                    self.assert_exited(process)
                    raise InterruptedError("during job cleanup")
                return result
            with patch.object(windows.api, "TerminateJobObject", interrupted):
                result = job.close(time.monotonic()+2)
            self.assertEqual(len(calls), 2)
            self.assertIn(pid, result["terminated_pids"])
            self.assertEqual(result["survivor_pids"], [])


    def test_relative_logs_and_nul_working_directory_refuse_before_creation(self):
        for label in ("relative-log", "nul-cwd", "unc-app"):
            directory = self.root / label
            directory.mkdir()
            cwd = str(directory) + ("\0ignored" if label == "nul-cwd" else "")
            stdout = Path("out") if label == "relative-log" else directory / "out"
            with chdir(directory), windows.Job() as job:
                with patch.object(windows.api, "CreateProcessW", side_effect=AssertionError("invalid paths reached CreateProcessW")) as create:
                    app = r"\\server\share\app.exe" if label == "unc-app" else sys.executable
                    with self.assertRaises(ValueError):
                        job.launch([app, "-c", "pass"], child_env(), cwd, stdout, directory/'err')
                    create.assert_not_called()


    def test_main_mapping_must_match_app_even_when_hardlinks_share_file_identity(self):
        original_dir = self.root / "original"
        original_dir.mkdir()
        original_app = original_dir / Path(sys.executable).name
        shutil.copyfile(sys.executable, original_app)
        alias = self.root / original_app.name
        os.link(original_app, alias)
        for pattern in ("python*.dll", "vcruntime*.dll"):
            for dll in Path(sys.executable).parent.glob(pattern):
                shutil.copyfile(dll, self.root / dll.name)
        env = {**child_env(), "PYTHONHOME": sys.base_prefix}
        library = Path(os.environ["SystemRoot"]) / "System32/kernel32.dll"
        code = "import os,time; from pathlib import Path; Path('ready').write_text(str(os.getpid())); time.sleep(20)"
        with windows.Job() as job:
            pid = job.launch([str(alias), "-c", code], env, self.root, self.root/'out', self.root/'err')
            self.ready(self.root / "ready")
            proof = job.observe(pid, alias, library)
            main = proof["modules"][0]
            self.assertEqual(main["mapped_path"].casefold(), windows.device_path(alias))
            self.assertNotEqual(main["mapped_path"].casefold(), windows.device_path(original_app))
            original, linked = windows.file_identity(original_app), windows.file_identity(alias)
            self.assertEqual((original["volume"], original["file_index"]),
                             (linked["volume"], linked["file_index"]))
            with self.assertRaisesRegex(ValueError, "main executable mapping"):
                job.observe(pid, original_app, library)

    def unassigned_cleanup_retry(self, failure):
        job, backups, termination_calls = windows.Job(), [], []
        current = windows.api.GetCurrentProcess()
        def denied_assignment(*args):
            backup = W.HANDLE()
            windows.checked(windows.api.DuplicateHandle(current, job.process, current,
                                                        C.byref(backup), 0, False, 2))
            backups.append(backup.value)
            C.set_last_error(5)
            return False
        def failed_termination(*args):
            termination_calls.append(True)
            if failure == "timeout":
                return True  # Model a successful request whose process does not exit.
            if failure == "keyboard":
                raise KeyboardInterrupt("cleanup keyboard interruption")
            C.set_last_error(5)
            return False
        try:
            with patch.object(windows.api, "AssignProcessToJobObject", denied_assignment):
                with patch.object(windows.api, "TerminateProcess", failed_termination):
                    expected = {"keyboard":KeyboardInterrupt, "timeout":TimeoutError, "error":OSError}[failure]
                    with self.assertRaises(expected):
                        self.launch(job, "from pathlib import Path; Path('ran').write_text('bad')")
                self.assertEqual(len(termination_calls), 1)
                self.assertIsNotNone(job.process, "sole unassigned-root handle was discarded")
                self.assertEqual(windows.api.WaitForSingleObject(backups[0], 0), 258)
                self.assertTrue(job.cleanup_error)
                result = job.close(time.monotonic()+2)
            self.assert_exited(backups[0])
            self.assertIsNone(job.process)
            self.assertIsNone(job.cleanup_error)
            self.assertEqual(result["survivor_pids"], [])
            self.assertFalse((self.root / "ran").exists())
        finally:
            for handle in backups:
                if windows.api.WaitForSingleObject(handle, 0) == 258:
                    windows.checked(windows.api.TerminateProcess(handle, 1))
                self.assert_exited(handle)
                windows.checked(windows.api.CloseHandle(handle))
            if job.process or job.handle:
                job.close(time.monotonic()+2)

    def test_unassigned_termination_failure_retains_handle_for_retry(self):
        self.unassigned_cleanup_retry("error")

    def test_unassigned_termination_timeout_retains_handle_for_retry(self):
        self.unassigned_cleanup_retry("timeout")

    def test_keyboard_interruption_retains_unassigned_root_without_silent_retry(self):
        self.unassigned_cleanup_retry("keyboard")

    def duplicate_interruption(self, exception_type):
        def count():
            value = W.DWORD()
            windows.checked(windows.api.GetProcessHandleCount(windows.api.GetCurrentProcess(), C.byref(value)))
            return value.value
        for position in (1, 2, 3):
            with self.subTest(duplicate=position):
                outputs = self.root / str(position)
                outputs.mkdir()
                before, duplicates = count(), []
                duplicate = windows.api.DuplicateHandle
                def interrupted(*args):
                    result = duplicate(*args)
                    windows.checked(result)
                    handle = C.cast(args[3], C.POINTER(W.HANDLE)).contents.value
                    duplicates.append(handle)
                    self.assertTrue(os.get_handle_inheritable(handle))
                    if len(duplicates) == position:
                        raise exception_type("after native DuplicateHandle returned")
                    return result
                try:
                    with windows.Job() as job:
                        with (patch.object(windows.api, "DuplicateHandle", interrupted),
                              patch.object(windows.api, "CreateProcessW") as create):
                            with self.assertRaises(exception_type):
                                job.launch([sys.executable, "-c", "pass"], child_env(), outputs,
                                           outputs/'out', outputs/'err')
                            create.assert_not_called()
                    self.assertEqual(count(), before)
                    for handle in duplicates:
                        with self.assertRaises(OSError) as error:
                            os.get_handle_inheritable(handle)
                        self.assertEqual(error.exception.winerror, 6)
                finally:
                    # Old-predicate runs must also release their known leaked duplicates.
                    for handle in duplicates:
                        try:
                            inheritable = os.get_handle_inheritable(handle)
                        except OSError as error:
                            if error.winerror != 6:
                                raise
                        else:
                            self.assertTrue(inheritable)
                            windows.checked(windows.api.CloseHandle(handle))

    def test_duplicate_output_handles_close_on_interrupted_return(self):
        self.duplicate_interruption(InterruptedError)

    def test_duplicate_output_handles_close_on_keyboard_interruption(self):
        self.duplicate_interruption(KeyboardInterrupt)

    def test_handles_close_and_unsupported_host_is_refused(self):
        def count():
            value = W.DWORD()
            windows.checked(windows.api.GetProcessHandleCount(windows.api.GetCurrentProcess(), C.byref(value)))
            return value.value
        before = count()
        for i in range(3):
            output = self.root / str(i)
            output.mkdir()
            with windows.Job() as job:
                job.launch([sys.executable, "-c", "pass"], child_env(), output, output/'out', output/'err')
                self.assertEqual(job.wait(time.monotonic()+3), 0)
        self.assertEqual(count(), before)
        with patch.object(windows.sys, "platform", "linux"):
            with self.assertRaisesRegex(ValueError, "Windows x64"):
                windows.Job()


if __name__ == "__main__":
    unittest.main()
