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
 {"action":"group_start","name":name.partition(".")[0]},
 {"action":"test_start","test":name},
 {"action":"test_status","test":name,"status":"PASS","message":"Expected TEST-UNEXPECTED-FAIL text"},
 {"action":"test_end","test":name,"status":"PASS"},
 {"action":"group_end","name":name.partition(".")[0]},
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
        cancellation = patch.object(runner, "TERMINATION_REASON", None)
        cancellation.start()
        self.addCleanup(cancellation.stop)

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
                   "[123] Hit MOZ_CRASH(fixture) at fixture.cpp:4",
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

    def test_expected_prose_and_crash_reporting_setup_are_not_failures(self):
        self.child(self.root, "Expected assertion failure; leak test data.\n"
                             "Setting up crash reporting")
        result = accounting.check_output(self.root / "native.jsonl", self.root / "stdout.log",
                                         self.root / "stderr.log", self.case["filter"], 0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["coverage"], "none")
        self.assertEqual(result["leak_check"], "unavailable")
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
        receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib"),
                   "refcount_logging": False}
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
        self.assertEqual(result["leak_check"], "unavailable")
        self.assertTrue(all(r["leak_check"] == "unavailable" for r in result["results"]))
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
        receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib"),
                   "refcount_logging": False}
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
            with self.assertRaisesRegex(ValueError, "different libxul image"):
                processes.loaded_files(123, library, library)
            maps.return_value = (f"00-10 r-xp 0 00:00 {inode} {library.resolve()}\n"
                                 f"10-20 r-xp 0 00:00 {inode+1} /different/libxul.so\n")
            with self.assertRaisesRegex(ValueError, "different libxul image"):
                processes.loaded_files(123, library, library)
            same.return_value = False
            self.assertIsNone(processes.loaded_files(123, library, library))


    def test_refcount_capability_is_required_and_logging_builds_stay_held(self):
        for index, capability in enumerate(({}, {"refcount_logging": True}, {"refcount_logging": "false"})):
            with self.subTest(receipt=capability):
                config, receipt, runner_path = self.receipt_fixture()
                del receipt["refcount_logging"]
                receipt.update(capability)
                self.bind_receipt(config, receipt)
                config["evidence"] = str(self.root / str(index))
                with (patch.object(runner.sys, "platform", "linux"),
                      patch.object(runner, "__file__", str(runner_path)),
                      patch.object(runner, "verify", return_value={}),
                      patch.object(processes, "capture") as capture):
                    result = runner.run_batch(config)
                capture.assert_not_called()
                self.assertFalse(result["ok"])
                self.assertIn("refcount", result["infrastructure_error"])
                self.assertEqual(result["counts"]["NOTRUN"], 2)
                self.assertTrue(all(r["leak_check"] == "unavailable" for r in result["results"]))
        config, receipt, runner_path = self.receipt_fixture()
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)),
              patch.object(runner, "verify", return_value={}),
              patch.object(processes, "capture", side_effect=self.clean_capture)):
            result = runner.run_batch(config)
        self.assertTrue(result["ok"])
        self.assertEqual(result["leak_check"], "unavailable")
        self.assertTrue(all(r["leak_check"] == "unavailable" for r in result["results"]))

    def clean_capture(self, argv, env, cwd, output, *args):
        self.child(output, selected=env["GTEST_FILTER"])
        runner.save(output / "process.json", {"pid": 123, "exit_code": 0, "timed_out": False,
                    "loaded": {"maps":"synthetic", "pid":123}, "terminated_pids":[], "survivor_pids":[]})

    def test_signal_during_hashes_after_permanently_refuses_later_launches(self):
        config = self.config()
        calls = []
        def verify(*args):
            calls.append(args)
            if len(calls) == 2:
                runner.handle_termination(runner.signal.SIGTERM, None)
            return {"fixture":"unchanged"}
        receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib"),
                   "refcount_logging": False}
        with (patch.object(runner, "prepare", return_value=receipt),
              patch.object(runner, "verify", verify),
              patch.object(processes, "capture", side_effect=self.clean_capture) as capture):
            result = runner.run_batch(config)
            self.assertEqual(capture.call_count, 1)
            second = runner.run_batch({**config, "evidence": str(self.root / "later-batch")})
            self.assertEqual(capture.call_count, 1)
        self.assertEqual([r["observed"] for r in result["results"]], ["FAIL", "NOTRUN"])
        self.assertTrue(result["results"][0]["interrupted"])
        self.assertIn("termination requested", result["results"][1]["reason"])
        self.assertIn("termination requested", result["results"][0]["identity_error"])
        self.assertEqual(second["counts"]["NOTRUN"], 2)
        self.assertFalse(result["ok"])
        original_reason = runner.TERMINATION_REASON
        runner.handle_termination(runner.signal.SIGINT, None)
        self.assertEqual(runner.TERMINATION_REASON, original_reason)
        with self.assertRaisesRegex(InterruptedError, "termination requested"):
            runner.require_running()

    def test_result_finalization_cancellation_stops_but_io_failure_continues(self):
        for cancelled in (True, False):
            with self.subTest(cancelled=cancelled), patch.object(runner, "TERMINATION_REASON", None):
                config = {**self.config(), "evidence": str(self.root / str(cancelled))}
                receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib"),
                           "refcount_logging": False}
                save = runner.save
                failed = []
                def finalize(path, value):
                    if Path(path).name == "result.json" and not failed:
                        failed.append(path)
                        if cancelled:
                            runner.handle_termination(runner.signal.SIGINT, None)
                        raise OSError("synthetic evidence write failure")
                    save(path, value)
                with (patch.object(runner, "prepare", return_value=receipt),
                      patch.object(runner, "verify", return_value={"fixture":"unchanged"}),
                      patch.object(runner, "save", finalize),
                      patch.object(processes, "capture", side_effect=self.clean_capture) as capture):
                    result = runner.run_batch(config)
                self.assertEqual(capture.call_count, 1 if cancelled else 2)
                self.assertEqual([r["observed"] for r in result["results"]],
                                 ["FAIL", "NOTRUN" if cancelled else "PASS"])
                first = result["results"][0]
                self.assertEqual(first["interrupted"], cancelled)
                self.assertEqual(first["first_failure"]["action"], "finalization")
                self.assertFalse(result["ok"])
                if cancelled:
                    self.assertIn("termination requested", result["results"][1]["reason"])

    def test_signal_during_summary_preserves_complete_failure_ledger(self):
        config = self.config()
        receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib"),
                   "refcount_logging": False}
        save = runner.save
        def finalize(path, value):
            if Path(path).name == "summary.json":
                Path(path).write_text('{"partial":')
                runner.handle_termination(runner.signal.SIGTERM, None)
            save(path, value)
        with (patch.object(runner, "prepare", return_value=receipt),
              patch.object(runner, "verify", return_value={"fixture":"unchanged"}),
              patch.object(runner, "save", finalize),
              patch.object(processes, "capture", side_effect=self.clean_capture)):
            result = runner.run_batch(config)
        self.assertFalse(result["ok"])
        self.assertTrue(result["interrupted"])
        self.assertEqual(result["requested"], 2)
        self.assertEqual([r["id"] for r in result["results"]], config["select"])
        self.assertEqual((Path(config["evidence"]) / "summary.json").read_text(), '{"partial":')
        self.assertEqual(json.loads((Path(config["evidence"]) / "interrupted-summary.json").read_text()), result)

    def test_stale_profile_in_resolved_executable_directory_refuses_launch(self):
        config = self.config()
        output, real = self.root / "case", self.root / "real-bin"
        output.mkdir()
        real.mkdir()
        stale = real / "cpp-unit-profd-stale"
        stale.mkdir()
        receipt = {"app": str(self.root / "alias-bin/app"), "library": str(self.root / "lib"),
                   "refcount_logging": False}
        with (patch.object(Path, "resolve", return_value=real / "app"),
              patch.object(runner, "verify", return_value={}),
              patch.object(processes, "capture") as capture):
            result = runner.run_case(config, receipt, self.case, output,
                                     time.monotonic()+10, time.monotonic()+20)
        capture.assert_not_called()
        self.assertEqual(result["observed"], "NOTRUN")
        self.assertEqual(result["profile_root"], str(real))
        self.assertEqual(result["preexisting_profiles"], [str(stale)])
        self.assertIn("stale cpp-unit-profd", result["error"])

    def test_deadline_shortened_timeout_remains_failed_and_is_labelled(self):
        config = {**self.config(), "timeout_seconds":20}
        output = self.root / "case"
        output.mkdir()
        receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib"),
                   "refcount_logging": False}
        def capture(*args):
            self.clean_capture(*args)
            path = output / "process.json"
            record = json.loads(path.read_text())
            record["timed_out"] = True
            path.write_text(json.dumps(record))
        with (patch.object(runner, "verify", return_value={}),
              patch.object(processes, "capture", capture)):
            result = runner.run_case(config, receipt, self.case, output,
                                     time.monotonic()+10, time.monotonic()+20)
        self.assertFalse(result["ok"])
        self.assertEqual(result["observed"], "FAIL")
        self.assertEqual(result["timeout_kind"], "deadline-shortened")


    def receipt_fixture(self):
        config = self.config()
        source, obj = Path(config["source"]), Path(config["objdir"])
        app, library = obj / "dist/bin/app", obj / "dist/bin/gtest/libxul.so"
        runner_path = source / "comm/mailnews/db/panorama/test/delivery/run_native.py"
        receipt = {"build_identity":"synthetic", "refcount_logging":False,
                   "comm_revision":"1"*40, "gecko_revision":"efd2d1e6f77570ae6bc5294731a68101e45c81a3",
                   "app":str(app), "library":str(library), "mozconfig":str(obj / "mozconfig")}
        paths = ([source / "comm" / p for p in runner.COMM_INPUTS] +
                 [source / p for p in runner.GECKO_INPUTS] +
                 [app, library, obj / "dist/bin/dependentlibs.list.gtest",
                  obj / "dist/bin/application.ini", obj / "dist/bin/platform.ini",
                  obj / "config.status", Path(receipt["mozconfig"])])
        for path in paths:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic fixture")
        (source / "xpcom/base/nsDebugImpl.cpp").write_text("###!!! ASSERTION")
        (source / "xpcom/base/nsTraceRefcnt.cpp").write_text("XPCOM_MEM_LEAK_LOG")
        (source / "mfbt/Assertions.h").write_text("Assertion failure: Hit MOZ_CRASH(")
        receipt["inputs"] = {str(p):runner.digest(p, time.monotonic()+5) for p in paths}
        self.bind_receipt(config, receipt)
        return config, receipt, runner_path

    def bind_receipt(self, config, receipt):
        Path(config["receipt"]).write_text(json.dumps(receipt))
        config["receipt_sha256"] = runner.digest(config["receipt"], time.monotonic()+5)

    def test_receipt_must_bind_the_gtest_dependency_list(self):
        config, receipt, runner_path = self.receipt_fixture()
        dependency = str(Path(config["objdir"]) / "dist/bin/dependentlibs.list.gtest")
        identity = receipt["inputs"].pop(dependency)
        self.bind_receipt(config, receipt)
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)),
              patch.object(runner, "verify") as verify):
            with self.assertRaisesRegex(ValueError, "omits required"):
                runner.prepare(config, time.monotonic()+5)
            verify.assert_not_called()
            receipt["inputs"][dependency] = identity
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic()+5), receipt)
            verify.assert_called_once()


    def test_receipt_must_bind_each_suites_implementation_header_and_fixture(self):
        config, receipt, runner_path = self.receipt_fixture()
        dependencies = ("src/DatabaseCore.cpp", "src/DatabaseCore.h",
                        "src/Message.cpp", "src/Message.h", "src/PerFolderDatabase.cpp",
                        "src/PerFolderDatabase.h", "test/gtest/TestDeliveryFolderInfoProperties.cpp")
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)),
              patch.object(runner, "verify") as verify):
            for relative in dependencies:
                path = str(Path(config["source"]) / "comm/mailnews/db/panorama" / relative)
                identity = receipt["inputs"].pop(path, "0" * 64)
                self.bind_receipt(config, receipt)
                with self.subTest(path=relative), self.assertRaisesRegex(ValueError, "omits required"):
                    runner.prepare(config, time.monotonic()+5)
                receipt["inputs"][path] = identity
            verify.assert_not_called()


    def test_filter_receipt_binds_predicates_identity_and_preconditions(self):
        config, receipt, runner_path = self.receipt_fixture()
        dependencies = [
            "mailnews/db/panorama/src/LiveView.cpp",
            "mailnews/db/panorama/src/LiveView.h",
            "mailnews/db/panorama/src/LiveViewFilters.h",
            "mailnews/db/panorama/src/LiveViewFilters.cpp",
            "mailnews/db/panorama/src/VirtualFolderWrapper.cpp",
            "mailnews/db/panorama/src/VirtualFolderWrapper.h",
            "mailnews/db/panorama/src/Message.cpp",
            "mailnews/db/panorama/src/Message.h",
            "mailnews/db/panorama/src/MessageDatabase.cpp",
            "mailnews/db/panorama/src/MessageDatabase.h",
            "mailnews/db/panorama/src/FolderDatabase.cpp",
            "mailnews/db/panorama/src/FolderDatabase.h",
            "mailnews/db/panorama/src/DetachedMsgHdr.cpp",
            "mailnews/db/panorama/src/DetachedMsgHdr.h",
            "mailnews/base/src/nsMsgAccountManager.cpp",
            "mailnews/base/src/nsMsgAccountManager.h",
            "mailnews/search/src/nsMsgFilterService.cpp",
            "mailnews/search/src/nsMsgFilterService.h",
            "mailnews/search/src/nsMsgFilterList.cpp",
            "mailnews/search/src/nsMsgFilterList.h",
            "mailnews/search/src/nsMsgFilter.cpp",
            "mailnews/search/src/nsMsgFilter.h",
            "mailnews/search/src/nsMsgSearchTerm.cpp",
            "mailnews/search/src/nsMsgSearchTerm.h",
        ]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)),
              patch.object(runner, "verify") as verify):
            for relative in dependencies:
                path = str(Path(config["source"]) / "comm" / relative)
                with self.subTest(path=relative):
                    self.assertTrue(path in receipt["inputs"], relative)
                    identity = receipt["inputs"].pop(path)
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic()+5)
                    receipt["inputs"][path] = identity
            verify.assert_not_called()
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic()+5), receipt)
            verify.assert_called_once()

    def test_message_references_boundary_uses_catalog_timeout_and_rejects_timeout_pass(self):
        selected = "DISABLED_DeliveryMessageReferences.CountOverflowLeavesZero"
        case = next((c for c in runner.CASES.values() if c["filter"] == selected), None)
        self.assertIsNotNone(case, "The accepted overflow case must be selectable")
        config = self.config()
        receipt = {"app": str(self.root / "app"), "library": str(self.root / "lib"),
                   "refcount_logging": False}
        def capture(argv, env, cwd, output, timeout, *args):
            self.assertEqual(timeout, 1800)
            self.assertEqual(env["GTEST_FILTER"], selected)
            self.assertIn("--gtest_also_run_disabled_tests", argv)
            self.child(output, selected=selected)
            runner.save(output / "process.json", {"pid": 123, "exit_code": 0,
                        "timed_out": True, "terminated_pids": [], "survivor_pids": [],
                        "loaded": {"maps": "synthetic", "pid": 123}})
        with (patch.object(runner, "verify", return_value={"fixture": "unchanged"}),
              patch.object(processes, "capture", capture)):
            result = runner.run_case(config, receipt, case, self.root,
                                     time.monotonic()+3600, time.monotonic()+3700)
        self.assertFalse(result["ok"])
        self.assertEqual(result["observed"], "FAIL")
        self.assertEqual(result["timeout_seconds"], 1800)
        self.assertEqual(result["timeout_kind"], "case-limit")
        self.assertEqual(result["coverage"], "none")


    def test_message_references_receipt_binds_adapter_fixture_and_fault_sources(self):
        config, receipt, runner_path = self.receipt_fixture()
        source = Path(config["source"])
        paths = [source / "comm" / name for name in (
            "mailnews/db/panorama/test/gtest/TestDeliveryMessageReferences.cpp",
            "mailnews/base/public/nsIMsgHdr.idl")]
        paths += [source / name for name in (
            "storage/mozStoragePrivateHelpers.cpp", "storage/mozStorageStatement.cpp",
            "storage/mozIStorageFunction.idl", "storage/mozIStorageValueArray.idl")]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)),
              patch.object(runner, "verify") as verify):
            for path in paths:
                identity = receipt["inputs"].pop(str(path), "0" * 64)
                self.bind_receipt(config, receipt)
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, "omits required"):
                    runner.prepare(config, time.monotonic()+5)
                receipt["inputs"][str(path)] = identity
            verify.assert_not_called()

    def test_capture_rechecks_images_after_initial_mapping_proof(self):
        class Child:
            pid = 123
            def poll(self):
                return None
            def wait(self, timeout):
                return 0
        with (patch.object(processes, "initialize"),
              patch.object(processes.subprocess, "Popen", return_value=Child()),
              patch.object(processes, "loaded_files", side_effect=[{"maps":"first"},
                           ValueError("different libxul image mapping")]) as loaded,
              patch.object(processes, "cleanup", return_value={"terminated_pids":[], "survivor_pids":[]}),
              patch.object(os, "waitpid", side_effect=ChildProcessError, create=True)):
            with self.assertRaisesRegex(ValueError, "different libxul image"):
                processes.capture(["synthetic"], {}, self.root, self.root, 2,
                                  time.monotonic()+5, Path("app"), Path("libxul.so"))
        self.assertEqual(loaded.call_count, 2)
        record = json.loads((self.root / "process.json").read_text())
        self.assertIn("different libxul image", record["process_error"])

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



    def test_new_native_receipts_bind_properties_aliases_schema_and_close(self):
        config, receipt, runner_path = self.receipt_fixture()
        comm_paths = ["mailnews/db/panorama/" + p for p in (
            "test/gtest/TestDeliveryCoreProperties.cpp", "test/gtest/TestDeliveryMessageReferences.cpp",
            "src/DatabaseCore.cpp", "src/DatabaseCore.h", "src/DatabaseUtils.cpp", "src/DatabaseUtils.h",
            "src/Message.cpp", "src/Message.h", "src/MessageDatabase.cpp", "src/MessageDatabase.h",
            "src/DetachedMsgHdr.cpp", "src/DetachedMsgHdr.h", "src/FolderDatabase.cpp", "src/FolderDatabase.h",
            "public/nsIMessageDatabase.idl", "public/moz.build", "src/moz.build", "test/gtest/moz.build")]
        gecko_paths = ["storage/" + p for p in (
            "mozStorageService.cpp", "mozStorageService.h", "mozIStorageService.idl",
            "mozIStorageConnection.idl", "mozIStorageStatement.idl", "mozIStorageAsyncConnection.idl")]
        gecko_paths += ["xpcom/threads/" + p for p in (
            "nsIEventTarget.idl", "nsThreadUtils.h", "nsThreadUtils.cpp", "SpinEventLoopUntil.h")]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)), patch.object(runner, "verify") as verify):
            for relative in ["comm/" + p for p in comm_paths] + gecko_paths:
                path = str(Path(config["source"]) / relative)
                with self.subTest(path=relative):
                    self.assertIn(path, receipt["inputs"])
                    identity = receipt["inputs"].pop(path)
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic()+5)
                    receipt["inputs"][path] = identity
            verify.assert_not_called()
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic()+5), receipt)


    def test_thread_and_uint32_receipts_require_consumer_parser_and_binding_sources(self):
        config, receipt, runner_path = self.receipt_fixture()
        dependencies = ["comm/mailnews/db/panorama/src/Thread.cpp",
                        "comm/mailnews/db/panorama/src/Thread.h",
                        "comm/mailnews/base/public/nsIMsgThread.idl",
                        "comm/mailnews/base/src/nsMsgUtils.cpp", "comm/mailnews/base/src/nsMsgUtils.h",
                        "storage/mozStorageBindingParams.cpp", "storage/mozStorageBindingParams.h"]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)), patch.object(runner, "verify") as verify):
            for relative in dependencies:
                path = str(Path(config["source"]) / relative)
                with self.subTest(path=relative):
                    identity = receipt["inputs"].pop(path)
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic()+5)
                    receipt["inputs"][path] = identity
            verify.assert_not_called()
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic()+5), receipt)


    def test_complete_publication_receipts_bind_raw_header_adapter_and_optionals(self):
        config, receipt, runner_path = self.receipt_fixture()
        dependencies = ["comm/mailnews/db/msgdb/public/nsIMsgDatabase.idl",
                        "comm/mailnews/base/public/MailNewsTypes.h",
                        "comm/mailnews/db/panorama/src/PerFolderDatabase.cpp",
                        "comm/mailnews/db/panorama/src/PerFolderDatabase.h",
                        "comm/mailnews/db/panorama/src/DetachedMsgHdr.cpp",
                        "comm/mailnews/db/panorama/src/DetachedMsgHdr.h",
                        "comm/mailnews/base/src/nsMsgUtils.cpp",
                        "comm/mailnews/base/src/nsMsgUtils.h",
                        "mfbt/Maybe.h", "mfbt/RefPtr.h"]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)), patch.object(runner, "verify") as verify):
            for relative in dependencies:
                path = str(Path(config["source"]) / relative)
                with self.subTest(path=relative):
                    self.assertIn(path, receipt["inputs"])
                    identity = receipt["inputs"].pop(path)
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic()+5)
                    receipt["inputs"][path] = identity
            verify.assert_not_called()
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic()+5), receipt)

    def test_captured_receipt_requires_progress_fallible_array_and_string_sources(self):
        config, receipt, runner_path = self.receipt_fixture()
        paths = ("storage/mozIStorageProgressHandler.idl", "mfbt/fallible.h",
                 "memory/mozalloc/cxxalloc.h", "xpcom/ds/nsTArray.h", "xpcom/string/nsTSubstring.h")
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)), patch.object(runner, "verify") as verify):
            for relative in paths:
                path = str(Path(config["source"]) / relative)
                with self.subTest(path=relative):
                    self.assertIn(path, receipt["inputs"])
                    identity = receipt["inputs"].pop(path)
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic()+5)
                    receipt["inputs"][path] = identity
            verify.assert_not_called()
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic()+5), receipt)


    def test_component_receipt_requires_schema_writer_fixture_and_storage_apis(self):
        config, receipt, runner_path = self.receipt_fixture()
        dependencies = ["comm/mailnews/db/panorama/" + name for name in (
            "src/MessageDatabase.cpp", "src/MessageDatabase.h", "src/DatabaseCore.cpp",
            "src/DatabaseCore.h", "src/Message.cpp", "src/Message.h", "src/FolderDatabase.cpp",
            "src/FolderDatabase.h", "src/DatabaseUtils.cpp", "src/DatabaseUtils.h",
            "test/gtest/TestDeliveryCoreReferences.cpp", "test/gtest/moz.build")]
        dependencies += ["storage/mozIStorageConnection.idl", "storage/mozIStorageAsyncConnection.idl",
                         "storage/mozIStorageStatement.idl",
                         "storage/mozIStorageProgressHandler.idl", "storage/mozStorageStatement.cpp",
                         "xpcom/ds/nsTArray.h", "mfbt/fallible.h"]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)), patch.object(runner, "verify") as verify):
            for relative in dependencies:
                path = str(Path(config["source"]) / relative)
                with self.subTest(path=relative):
                    self.assertIn(path, receipt["inputs"])
                    identity = receipt["inputs"].pop(path)
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic()+5)
                    receipt["inputs"][path] = identity
            verify.assert_not_called()
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic()+5), receipt)


    def test_known_arts_receipt_requires_owned_string_cleanup_and_fixture_sources(self):
        config, receipt, runner_path = self.receipt_fixture()
        dependencies = ["comm/mailnews/db/panorama/" + name for name in (
            "src/PerFolderDatabase.cpp", "src/PerFolderDatabase.h", "src/FolderDatabase.cpp",
            "src/FolderDatabase.h", "src/MessageDatabase.cpp", "src/MessageDatabase.h",
            "src/DatabaseCore.cpp", "src/DatabaseCore.h",
            "test/gtest/TestDeliveryFolderInfoProperties.cpp", "test/gtest/moz.build",
            "public/nsIMessageDatabase.idl", "public/nsIDatabaseCore.idl")]
        dependencies += ["comm/mailnews/db/msgdb/public/nsIDBFolderInfo.idl",
                         "comm/mailnews/db/msgdb/public/nsIMsgDatabase.idl",
                         "xpcom/string/nsReadableUtils.h", "xpcom/string/nsReadableUtils.cpp",
                         "xpcom/base/nsCOMPtr.h", "mfbt/ScopeExit.h", "xpcom/ds/nsIVariant.idl",
                         "third_party/googletest/googletest/include/gtest/internal/gtest-internal.h"]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)), patch.object(runner, "verify") as verify):
            for relative in dependencies:
                key = str(Path(config["source"]) / relative)
                with self.subTest(path=relative):
                    self.assertIn(key, receipt["inputs"])
                    identity = receipt["inputs"].pop(key)
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic()+5)
                    receipt["inputs"][key] = identity
            verify.assert_not_called()
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic()+5), receipt)



    def test_quarantine_receipt_requires_stream_interfaces_wrapper_and_linkage(self):
        config, receipt, runner_path = self.receipt_fixture()
        source = Path(config["source"])
        paths = [source / "comm" / p for p in (
            "mailnews/base/test/gtest/TestQuarantinedOutputStream.cpp",
            "mailnews/base/src/nsQuarantinedOutputStream.cpp", "mailnews/base/src/nsQuarantinedOutputStream.h",
            "mailnews/base/test/gtest/moz.build", "mailnews/base/src/moz.build")]
        paths += [source / p for p in ("xpcom/io/nsIOutputStream.idl", "xpcom/io/nsISafeOutputStream.idl",
            "xpcom/io/nsIInputStream.idl", "xpcom/io/nsIFile.idl", "xpcom/io/nsDirectoryServiceDefs.h",
            "netwerk/base/nsNetUtil.h", "third_party/googletest/googletest/include/gtest/gtest.h")]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)), patch.object(runner, "verify") as verify):
            for path in paths:
                with self.subTest(path=str(path)):
                    self.assertTrue(str(path) in receipt["inputs"], str(path))
                    identity = receipt["inputs"].pop(str(path))
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic()+5)
                    receipt["inputs"][str(path)] = identity
            verify.assert_not_called()


    def test_uid_receipt_requires_public_view_storage_and_close_inputs(self):
        config, receipt, runner_path = self.receipt_fixture()
        comm = ["mailnews/base/public/ImapTypes.idl", "mailnews/base/public/MailNewsTypes2.idl",
                "mailnews/base/src/nsMsgUtils.cpp", "mailnews/base/src/nsMsgUtils.h",
                "mailnews/protocols/common/src/OfflineStorage.cpp"]
        gecko = ["storage/mozIStorageBaseStatement.idl", "storage/mozIStorageBindingParams.idl",
                 "storage/mozStorageHelper.h", "mfbt/Try.h", "mfbt/ResultExtensions.h",
                 "xpcom/base/nsISupportsUtils.h", "xpcom/components/nsServiceManagerUtils.h",
                 "xpcom/threads/nsIEventTarget.idl", "xpcom/threads/SpinEventLoopUntil.h"]
        with (patch.object(runner.sys, "platform", "linux"),
              patch.object(runner, "__file__", str(runner_path)), patch.object(runner, "verify") as verify):
            for name in ["comm/" + p for p in comm] + gecko:
                path = str(Path(config["source"]) / name)
                with self.subTest(path=name):
                    self.assertIn(path, receipt["inputs"])
                    identity = receipt["inputs"].pop(path)
                    self.bind_receipt(config, receipt)
                    with self.assertRaisesRegex(ValueError, "omits required"):
                        runner.prepare(config, time.monotonic() + 5)
                    receipt["inputs"][path] = identity
            verify.assert_not_called()
            self.bind_receipt(config, receipt)
            self.assertEqual(runner.prepare(config, time.monotonic() + 5), receipt)


if __name__ == "__main__":
    unittest.main()
