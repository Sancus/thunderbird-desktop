# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Tiny Python children and temporary Git fixtures; never Thunderbird."""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import native_accounting as accounting
import native_process as processes
import run_native as runner

DUMMY = r'''
import json, sys
from pathlib import Path
name, raw, diagnostic, code = sys.argv[1:]
events = [
 {"action":"suite_start","source":"gtest","name":"gtest","tests":{}},
 {"action":"group_start","name":"DISABLED_DeliveryCoreReferences"},
 {"action":"test_start","test":name},
 {"action":"test_status","test":name,"status":"PASS","message":"Expected TEST-UNEXPECTED-FAIL text"},
 {"action":"test_end","test":name,"status":"PASS"},
 {"action":"group_end","name":"DISABLED_DeliveryCoreReferences"},
 {"action":"suite_end","source":"gtest"}]
text = "".join(json.dumps(e)+"\n" for e in events)
Path(raw).write_text(text, encoding="utf-8")
print(text, end="", flush=True)
print("Finished running GTest tests.", flush=True)
if diagnostic:
 print(diagnostic, file=sys.stderr, flush=True)
sys.exit(int(code))
'''


class NativeRunnerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.case = next(iter(runner.CASES.values()))

    def child(self, output, diagnostic="", code=0, selected=None):
        with (output / "stdout.log").open("xb") as out, (output / "stderr.log").open("xb") as err:
            return subprocess.run([sys.executable, "-c", DUMMY, selected or self.case["filter"],
                                   str(output / "native.jsonl"), diagnostic, str(code)],
                                  stdout=out, stderr=err, timeout=5, check=False).returncode

    def test_success_json_and_exit_zero_cannot_hide_late_shutdown_failures(self):
        markers = ["TEST-UNEXPECTED-FAIL | XPCOM shutdown failed with code 0x1",
                   "[123, Main Thread] ###!!! ASSERTION: fixture error",
                   "Assertion failure: false, at fixture.cpp:4",
                   "WARNING: Problem removing profile directory: file fixture.cpp:1",
                   "   0 |TOTAL                                 | 4 8| 2 2|",
                   "PROCESS-CRASH | selected case | signal 11",
                   json.dumps({"action":"test_start","test":"Other.Extra"})]
        for index, marker in enumerate(markers):
            with self.subTest(marker=marker):
                output = self.root / str(index)
                output.mkdir()
                self.assertEqual(self.child(output, marker), 0)
                result = accounting.check_output(output / "native.jsonl", output / "stdout.log",
                                                 output / "stderr.log", self.case["filter"], 0)
                self.assertTrue(result["log_complete"])
                self.assertFalse(result["ok"])
                self.assertEqual(result["first_failure"]["stream"], "stderr")
                self.assertIn(marker, result["first_failure"]["message"])

    def test_expected_prose_zero_leaks_and_crash_reporting_setup_are_not_failures(self):
        self.child(self.root, "Expected assertion failure; leak test data.\n"
                             "Setting up crash reporting\n   0 |TOTAL | 4 0| 2 0|")
        result = accounting.check_output(self.root / "native.jsonl", self.root / "stdout.log",
                                         self.root / "stderr.log", self.case["filter"], 0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["coverage"], "none")
        for code in (7, -11, None):
            self.assertFalse(accounting.check_output(self.root / "native.jsonl", self.root / "stdout.log",
                             self.root / "stderr.log", self.case["filter"], code)["ok"])
        (self.root / "stdout.log").write_text('{"action":"suite_end"}\n', encoding="utf-8")
        self.assertFalse(accounting.check_output(self.root / "native.jsonl", self.root / "stdout.log",
                         self.root / "stderr.log", self.case["filter"], 0)["ok"])

    def config(self):
        now = datetime.now(timezone.utc)
        receipt_path = self.root / "fixture-receipt.json"
        receipt_path.write_text("{\"fixture\":\"mocked provenance\"}")
        return {"receipt":str(receipt_path),"source": str(self.root / "source"), "objdir": str(self.root / "obj"),
                "evidence": str(self.root / "evidence"), "select": list(runner.CASES)[:2],
                "timeout_seconds": 5, "test_stop_utc": (now + timedelta(seconds=30)).isoformat(),
                "finalize_utc": (now + timedelta(seconds=120)).isoformat()}

    def test_failed_case_does_not_hide_later_case_and_exclusive_evidence(self):
        config = self.config()
        receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib")}
        calls = []
        def capture(argv, env, cwd, output, *args):
            calls.append((argv, env, cwd))
            self.assertEqual(env["GTEST_FILTER"], runner.CASES[config["select"][len(calls)-1]]["filter"])
            self.assertIn("--gtest_also_run_disabled_tests", argv)
            self.assertNotIn("MOZ_AUTOMATION", env)
            self.assertNotIn("GTEST_REPEAT", env)
            self.assertTrue(Path(env["MOZ_GTEST_LOG_PATH"]).is_file())
            self.child(output, "TEST-UNEXPECTED-FAIL | after suite" if len(calls) == 1 else "",
                       selected=env["GTEST_FILTER"])
            runner.save(output / "process.json", {"pid": 123, "exit_code": 0, "timed_out": False,
                        "terminated_pids": [], "survivor_pids": [], "loaded": {"maps": "synthetic", "pid":123}})
        with (patch.object(runner, "prepare", return_value=receipt),
              patch.object(runner, "verify", return_value={"fixture": "unchanged"}),
              patch.object(processes, "capture", capture), patch.dict(os.environ, {"GTEST_REPEAT":"9"})):
            result = runner.run_batch(config)
        self.assertFalse(result["ok"])
        self.assertEqual([r["observed"] for r in result["results"]], ["FAIL", "PASS"], [r.get("errors") for r in result["results"]])
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0][1]["HOME"], calls[1][1]["HOME"])
        with self.assertRaises(FileExistsError):
            runner.run_batch(config)

    def test_zero_selection_expired_deadline_and_platform_hold_have_complete_notrun(self):
        for label, change in (("empty", {"select": []}),
                               ("expired", {"test_stop_utc":"2000-01-01T00:00:00+00:00"}),
                               ("platform", {})):
            config = {**self.config(), **change, "evidence": str(self.root / label)}
            with patch.object(runner.sys, "platform", "win32"), patch.object(processes, "capture") as launch:
                result = runner.run_batch(config)
            launch.assert_not_called()
            self.assertFalse(result["ok"])
            self.assertEqual([r["id"] for r in result["results"]], config["select"])
            self.assertTrue(all(r["observed"] == "NOTRUN" for r in result["results"]))

    def test_identity_change_fails_case_even_with_complete_clean_child_output(self):
        config = self.config()
        output = self.root / "case"
        output.mkdir()
        receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib")}
        def capture(argv, env, cwd, out, *args):
            self.child(out)
            runner.save(out / "process.json", {"pid": 123, "exit_code": 0, "timed_out": False,
                        "loaded": {"maps":"synthetic", "pid":123}, "terminated_pids":[], "survivor_pids":[]})
        with (patch.object(runner, "verify", side_effect=[{"app":"old"}, ValueError("artifact changed")]),
              patch.object(processes, "capture", capture)):
            result = runner.run_case(config, receipt, self.case, output,
                                     time.monotonic()+10, time.monotonic()+20)
        self.assertFalse(result["ok"])
        self.assertEqual(result["observed"], "FAIL")
        self.assertEqual(result["identity_error"], "artifact changed")

    def test_real_child_exit_and_timeout_are_failures(self):
        self.assertEqual(self.child(self.root, code=7), 7)
        result = accounting.check_output(self.root / "native.jsonl", self.root / "stdout.log",
                                         self.root / "stderr.log", self.case["filter"], 7)
        self.assertFalse(result["ok"])
        self.assertEqual(result["first_failure"]["exit_code"], 7)
        with self.assertRaises(subprocess.TimeoutExpired):
            subprocess.run([sys.executable, "-c", "import time;time.sleep(1)"], timeout=0.05, check=False)
        self.assertFalse(accounting.check_output(self.root / "native.jsonl", self.root / "stdout.log",
                         self.root / "stderr.log", self.case["filter"], None, timed_out=True)["ok"])

    def test_build_receipt_hashes_and_ini_sections_are_independent_gates(self):
        source, obj = self.root / "source", self.root / "obj"
        comm = source / "comm"
        comm.mkdir(parents=True)
        receipt = {"inputs": {}}
        for directory, key in ((source, "gecko_revision"), (comm, "comm_revision")):
            def git(*args):
                return subprocess.run(["git", "-C", str(directory), "-c", "core.hooksPath=",
                                       "-c", "commit.gpgsign=false", "-c", "user.name=Fixture",
                                       "-c", "user.email=fixture@example.invalid", *args],
                                      capture_output=True, text=True, check=True).stdout.strip()
            git("init", "-q", "--template=")
            (directory / "tracked").write_text(key)
            git("add", "tracked")
            git("commit", "-q", "-m", "fixture")
            receipt[key] = git("rev-parse", "HEAD")
        binary = obj / "dist/bin"
        binary.mkdir(parents=True)
        app_ini, platform_ini = binary / "application.ini", binary / "platform.ini"
        app_ini.write_text("[App]\nSourceStamp=" + receipt["comm_revision"])
        platform_ini.write_text("[Build]\nSourceStamp=" + receipt["gecko_revision"])
        config = {"source":str(source), "objdir":str(obj), "receipt":str(self.root / "receipt.json")}
        def bind():
            receipt["inputs"] = {str(p):runner.digest(p, time.monotonic()+10) for p in (app_ini, platform_ini)}
            Path(config["receipt"]).write_text(json.dumps(receipt))
            config["receipt_sha256"] = runner.digest(config["receipt"], time.monotonic()+10)
        bind()
        runner.verify(config, receipt, time.monotonic()+10)
        app_ini.write_text("[App]\nSourceStamp=stale")
        with self.assertRaisesRegex(ValueError, "differs from build receipt"):
            runner.verify(config, receipt, time.monotonic()+10)
        bind()
        with self.assertRaisesRegex(ValueError, "SourceStamp"):
            runner.verify(config, receipt, time.monotonic()+10)
        app_ini.write_text("[Build]\nSourceStamp=" + receipt["comm_revision"])
        bind()
        with self.assertRaises(runner.configparser.Error):
            runner.verify(config, receipt, time.monotonic()+10)

    def test_pidfd_is_not_signalled_after_ownership_is_lost(self):
        opened = []
        def own():
            return set() if opened else {123}
        def open_pid(pid):
            opened.append(pid)
            return 55
        with (patch.object(processes, "descendants", own),
              patch.object(processes.signal, "SIGKILL", 9, create=True),
              patch.object(os, "pidfd_open", open_pid, create=True),
              patch.object(processes.signal, "pidfd_send_signal", create=True) as send,
              patch.object(os, "close") as close):
            result = processes.cleanup(time.monotonic()+1)
        send.assert_not_called()
        close.assert_called_once_with(55)
        self.assertEqual(result, {"terminated_pids":[], "survivor_pids":[]})

    def test_loaded_library_requires_actual_executable_and_matching_inode(self):
        library = self.root / "libxul.so"
        library.write_text("fixture library")
        inode = library.stat().st_ino
        with (patch.object(os.path, "samefile", return_value=True) as same,
              patch.object(os, "major", return_value=0, create=True),
              patch.object(os, "minor", return_value=0, create=True),
              patch.object(Path, "read_text") as maps):
            maps.return_value = f"00-10 r-xp 0 00:00 {inode} {library.resolve()}\n"
            self.assertIsNotNone(processes.loaded_files(123, library, library))
            maps.return_value = f"00-10 r-xp 0 00:00 {inode+1} {library.resolve()}\n"
            self.assertIsNone(processes.loaded_files(123, library, library))
            same.return_value = False
            self.assertIsNone(processes.loaded_files(123, library, library))

    def test_linux_orphan_cleanup_probe_or_windows_refusal(self):
        if sys.platform != "linux":
            with self.assertRaisesRegex(ValueError, "Windows held"):
                processes.initialize()
            return
        code = "import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time;time.sleep(20)'])"
        wrapper = "from pathlib import Path; import native_process as p,sys,time,json; " + \
                  "r=p.capture([sys.executable,'-c',sys.argv[1]],dict(__import__('os').environ)," + \
                  "Path(sys.argv[2]),Path(sys.argv[2]),2,time.monotonic()+6,Path(sys.executable),Path(sys.executable)); print(json.dumps(r))"
        result = subprocess.run([sys.executable, "-c", wrapper, code, str(self.root)],
                                cwd=runner.HERE, capture_output=True, text=True, timeout=10, check=True)
        record = json.loads(result.stdout)
        self.assertTrue(record["terminated_pids"])
        self.assertEqual(record["survivor_pids"], [])


if __name__ == "__main__":
    unittest.main()
