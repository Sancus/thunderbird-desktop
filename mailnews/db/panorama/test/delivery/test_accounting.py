# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Accounting tests use synthetic logs and mocked processes, never Thunderbird."""

import copy
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import run_acceptance as runner


class AccountingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / "raw.jsonl"
        self.case = {"id": "unit:one", "file": "test_one.js", "backend": "panorama",
                     "store": "mbox", "diagnostics": "folder", "readiness": "ready",
                     "fixture": "preconfigured-store", "manifest": "tests/manual.toml"}
        self.contract = {"folderURI": "mailbox://test/Inbox",
                         "contractBefore": "@mozilla.org/msgstore/berkeleystore;1"}
        self.folder = {**self.contract, "backend": "panorama", "expectedStore": "mbox",
                       "actualStore": "mbox", "defaulted": False}
        self.events = [
            {"action": "suite_start", "tests": {"manual.toml": ["test_one.js"]}},
            {"action": "test_start", "test": "test_one.js"},
            self.diag("BACKEND", {"expected": "panorama", "actualBackend": "panorama"}),
            self.diag("STORE_CONTRACT", self.contract), self.diag("FOLDER", self.folder),
            {"action": "test_status", "test": "test_one.js", "status": "PASS"},
            {"action": "test_end", "test": "test_one.js", "status": "PASS"},
            {"action": "suite_end"},
        ]

    def diag(self, kind, value):
        return {"action": "log", "level": "INFO",
                "message": '"DELIVERY_' + kind + " " + json.dumps(value) + '"'}

    def check(self, events, case=None, returncode=0):
        self.log.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
        return runner.check_log(self.log, case or self.case, returncode)

    def test_accepts_complete_folder_and_raw_db_evidence(self):
        self.assertTrue(self.check(self.events)["ok"])
        self.assertIsNone(self.check(self.events)["first_failure"])
        raw_case = {**self.case, "store": "none", "diagnostics": "backend"}
        self.assertTrue(self.check(self.events[:3] + self.events[5:], raw_case)["ok"])
        self.assertFalse(self.check(self.events, raw_case)["ok"])

    def test_rejects_empty_malformed_and_truncated_logs(self):
        for raw in ("", "{}\n", "[]\n", "not json\n", '{"action":',
                    json.dumps(self.events[0])):
            with self.subTest(raw=raw):
                self.log.write_text(raw, encoding="utf-8")
                self.assertFalse(runner.check_log(self.log, self.case)["ok"])
        for index in (0, 1, 6, 7):
            with self.subTest(missing=index):
                self.assertFalse(self.check(self.events[:index] + self.events[index + 1:])["ok"])

    def test_rejects_extra_duplicate_and_out_of_order_results(self):
        for index in (0, 1, 6, 7):
            repeated = self.events[:index] + [self.events[index]] + self.events[index:]
            self.assertFalse(self.check(repeated)["ok"])
        wrong = copy.deepcopy(self.events)
        wrong[1]["test"] = "test_other.js"
        self.assertFalse(self.check(wrong)["ok"])
        wrong = copy.deepcopy(self.events)
        wrong[0]["tests"]["manual.toml"].append("test_other.js")
        self.assertFalse(self.check(wrong)["ok"])
        self.assertFalse(self.check(self.events[:1] + [self.events[6]] + self.events[1:])["ok"])

    def test_rejects_skips_crashes_expected_failures_and_process_errors(self):
        for status in ("SKIP", "CRASH", "TIMEOUT", "FAIL", "NOTRUN"):
            events = copy.deepcopy(self.events)
            events[6].update(status=status, expected=status)
            self.assertFalse(self.check(events)["ok"])
        for event in ({"action": "crash"}, {"action": "log", "level": "ERROR", "message": "leak"},
                      {"action": "test_status", "test": "test_one.js", "status": "FAIL", "expected": "FAIL"}):
            self.assertFalse(self.check(self.events[:6] + [event] + self.events[6:])["ok"])
        self.assertFalse(self.check(self.events, returncode=1)["ok"])

    def test_requires_consistent_diagnostics_from_active_case(self):
        for index in (2, 3, 4):
            self.assertFalse(self.check(self.events[:index] + self.events[index + 1:])["ok"])
        for kind, data in (("BACKEND", {"expected": "panorama", "actualBackend": "mork"}),
                           ("FOLDER", {**self.folder, "actualStore": "maildir"})):
            wrong = self.events[:5] + [self.diag(kind, data)] + self.events[5:]
            self.assertFalse(self.check(wrong)["ok"])
        self.assertFalse(self.check(self.events + [self.events[2]])["ok"])
        pending = {**self.case, "readiness": "pending-contract"}
        self.assertFalse(self.check(self.events, pending)["ok"])

    def test_imap_mode_phase_and_pre_getter_default_observation(self):
        case = {**self.case, "id": "imap:panorama:mbox:Backend",
                "fixture": "account-factory", "phase": "imap-ready"}
        folder = {k: v for k, v in self.folder.items() if k != "defaulted"}
        mode = self.diag("IMAP_FIXTURE", {"mode": "account-factory",
                                         "backend": "panorama", "store": "mbox"})
        events = self.events[:3] + [
            mode, self.diag("STORE_CONTRACT", {**self.contract, "defaulted": False}),
            self.diag("FOLDER", folder), self.diag("PHASE", {"phase": "imap-ready"}),
        ] + self.events[5:]
        self.assertTrue(self.check(events, case)["ok"])
        self.assertFalse(self.check(events[:6] + events[7:], case)["ok"])
        self.assertFalse(self.check(events[:3] + events[4:], case)["ok"])
        wrong = self.diag("IMAP_FIXTURE", {"mode": "preconfigured-store",
                                          "backend": "panorama", "store": "mbox"})
        self.assertFalse(self.check(events[:3] + [wrong] + events[4:], case)["ok"])

    def test_factory_failure_claims_no_uid_or_storage_coverage(self):
        events = self.events[:3] + [self.diag("PHASE", {"phase": "imap-factory"})] + self.events[5:]
        result = self.check(events)
        self.assertFalse(result["ok"])
        self.assertTrue(result["factory_blocked"])
        self.assertEqual(result["coverage"], "none")

    def test_runner_unsets_automation_selects_one_file_and_keeps_failed_aggregate(self):
        config = {"source": str(self.root), "objdir": str(self.root / "obj"),
                  "python": "python", "evidence": str(self.root / "evidence")}
        (self.root / "obj/dist/bin").mkdir(parents=True)
        binary = "obj/dist/bin/xpcshell" + (".exe" if os.name == "nt" else "")
        for p in (binary, "obj/mozinfo.json"):
            (self.root / p).write_text("fixture", encoding="utf-8")
        source = self.root / "comm/tests"
        source.mkdir(parents=True)
        (source / "manual.toml").write_text('''[DEFAULT]
head = "head.js"
environment = ["PANORAMA_DELIVERY_EXPECT=panorama:mbox"]
prefs = [
  "mail.panorama.enabled=true",
  "mail.serverDefaultStoreContractID=@mozilla.org/msgstore/berkeleystore;1",
  "mail.server.default.storeContractID=@mozilla.org/msgstore/berkeleystore;1",
]
["test_one.js"]
''', encoding="utf-8")
        for name in ("head.js", "test_one.js"):
            (source / name).write_text("// fixture", encoding="utf-8")
        calls = []

        def fake_run(argv, **kwargs):
            calls.append(argv)
            self.assertNotIn("MOZ_AUTOMATION", kwargs["env"])
            self.assertEqual(kwargs["env"]["PANORAMA_DELIVERY_EXPECT"], "panorama:mbox")
            self.assertEqual(Path(argv[-1]), source / "test_one.js")
            raw = Path(argv[argv.index("--log-raw") + 1])
            raw.write_text("".join(json.dumps(e) + "\n" for e in self.events), encoding="utf-8")
            return SimpleNamespace(returncode=1 if len(calls) == 1 else 0)

        with (
            patch.dict(os.environ, {"MOZ_AUTOMATION": "1"}),
            patch.object(runner.subprocess, "run", fake_run),
        ):
            summary = runner.run_batch(config, [self.case, {**self.case, "id": "unit:two"}])
        self.assertEqual(len(calls), 2)
        self.assertFalse(summary["ok"])
        self.assertEqual([r["observed"] for r in summary["results"]], ["FAIL", "PASS"])
        self.assertEqual([r["disposition"] for r in summary["results"]], ["failed", "passed"])
        self.assertEqual(summary["results"][0]["argv"], calls[0])
        empty = {**config, "evidence": str(self.root / "empty")}
        self.assertFalse(runner.run_batch(empty, [])["ok"])
        with self.assertRaises(FileExistsError):
            runner.run_batch(config, [self.case])

    def test_manifest_expectation_and_fixture_scope_are_required(self):
        source = self.root / "comm/tests"
        source.mkdir(parents=True)
        manifest = source / "manual.toml"
        manifest.write_text('''[DEFAULT]
head = "head.js"
environment = ["PANORAMA_DELIVERY_EXPECT=panorama:none"]
prefs = ["mail.panorama.enabled=true"]
["test_one.js"]
''', encoding="utf-8")
        for name in ("head.js", "test_one.js"):
            (source / name).write_text("// fixture", encoding="utf-8")
        config = {"source": str(self.root)}
        case = {**self.case, "store": "none", "diagnostics": "backend", "fixture": "raw-db"}
        self.assertEqual(runner.prepare(config, case)[0], manifest)
        for changed in ({"fixture": "legacy-source"}, {"diagnostics": "folder"},
                        {"backend": "mork"}, {"file": "test_absent.js"}):
            with self.subTest(changed=changed), self.assertRaises((ValueError, KeyError)):
                runner.prepare(config, {**case, **changed})
        content = manifest.read_text().replace(
            "PANORAMA_DELIVERY_EXPECT=panorama:none", "OTHER=panorama:none"
        )
        manifest.write_text(content)
        with self.assertRaisesRegex(ValueError, "environment differs"):
            runner.prepare(config, case)

    def test_prepare_blocks_missing_peer_and_installed_shutdown_before_launch(self):
        source = self.root / "comm/tests"
        source.mkdir(parents=True)
        manifest = source / "manual.toml"
        manifest.write_text('''[DEFAULT]
head = "head.js"
environment = ["PANORAMA_DELIVERY_EXPECT=panorama:mbox"]
prefs = ["mail.panorama.enabled=true", "mail.serverDefaultStoreContractID=@mozilla.org/msgstore/berkeleystore;1", "mail.server.default.storeContractID=@mozilla.org/msgstore/berkeleystore;1"]
["test_one.js"]
["test_peer.js"]
''')
        for name in ("head.js", "test_one.js", "head_server.js"):
            (source / name).write_text("// fixture")
        config = {"source": str(self.root), "objdir": str(self.root / "obj"), "python": "python"}
        output = self.root / "blocked"
        output.mkdir()
        with patch.object(runner.subprocess, "run") as execute:
            record = runner.run_case(config, self.case, output)
        execute.assert_not_called()
        self.assertEqual(record["disposition"], "blocked")
        self.assertIn("blocked-dependency:", record["observed"])
        self.assertIn("test_peer.js", record["observed"])
        (source / "test_peer.js").write_text("// fixture")
        imap_case = {**self.case, "id": "imap:panorama:mbox:Backend"}
        with self.assertRaisesRegex(ValueError, "mailShutdown.js"):
            runner.prepare(config, imap_case)
        shutdown = self.root / "obj/_tests/xpcshell/comm/mailnews/resources/mailShutdown.js"
        shutdown.parent.mkdir(parents=True)
        shutdown.write_text("// matching installed fixture")
        self.assertIn(shutdown, runner.prepare(config, imap_case)[1])

    def test_source_validation_checks_nested_repositories_and_dirty_inputs(self):
        source = self.root / "source"
        comm = source / "comm"
        comm.mkdir(parents=True)
        hooks = self.root / "empty-hooks"
        hooks.mkdir()
        config = {"source": str(source)}
        for directory, key in ((source, "gecko_revision"), (comm, "comm_revision")):
            def git(*args):
                return runner.subprocess.run(
                    ["git", "-C", str(directory), "-c", "core.hooksPath=" + str(hooks),
                     "-c", "commit.gpgsign=false", "-c", "user.name=Fixture",
                     "-c", "user.email=fixture@example.invalid", *args],
                    capture_output=True, text=True, check=True).stdout.strip()
            git("init", "-q", "--template=")
            (directory / "tracked.txt").write_text("committed")
            git("add", "--", "tracked.txt")
            git("commit", "-q", "-m", "fixture")
            config[key] = git("rev-parse", "HEAD")
        runner.verify_source(config)
        for directory in (source, comm):
            with self.subTest(directory=directory):
                tracked = directory / "tracked.txt"
                tracked.write_text("changed")
                with self.assertRaisesRegex(ValueError, "dirty source checkout"):
                    runner.verify_source(config)
                tracked.write_text("committed")
                extra = directory / "untracked.txt"
                extra.write_text("not committed")
                with self.assertRaisesRegex(ValueError, "dirty source checkout"):
                    runner.verify_source(config)
                extra.unlink()
        runner.verify_source(config)

    def test_numeric_import_contract_gate_refuses_before_execution(self):
        inventory = json.loads((runner.HERE / "cases.json").read_text())
        case = next(c for c in inventory if c["id"] == "migration:NumericProperties")
        output = self.root / "pending"
        output.mkdir()
        config = {"source": str(self.root), "objdir": str(self.root), "python": "python"}
        with patch.object(runner.subprocess, "run") as execute:
            result = runner.run_case(config, case, output)
        execute.assert_not_called()
        self.assertFalse(result["ok"])
        self.assertEqual(result["observed"], "not-run")
        self.assertIn("contract approval is pending", result["errors"][0])

    def test_missing_or_unregistered_source_is_blocked_before_execution(self):
        config = {"source": str(self.root), "objdir": str(self.root), "python": "python"}
        output = self.root / "run"
        output.mkdir()
        with patch.object(runner.subprocess, "run") as execute:
            result = runner.run_case(config, self.case, output)
        execute.assert_not_called()
        self.assertFalse(result["ok"])
        self.assertEqual(result["observed"], "not-run")
        self.assertTrue((output / "request.json").is_file())

    def folder_events(self, names, phase=None):
        events = self.events[:3]
        for name in names:
            contract = {**self.contract, "folderURI": "mailbox://test/" + name}
            events += [self.diag("STORE_CONTRACT", contract),
                       self.diag("FOLDER", {**self.folder, **contract})]
        if phase:
            events.append(self.diag("PHASE", {"phase": phase}))
        return events + self.events[-3:]

    def test_transfer_requires_both_folders_and_terminal_phase(self):
        case = {**self.case, "phase": "local-copy-verified",
                "folder_roles": {"source": "source", "destination": "destination"}}
        events = self.folder_events(["source", "destination"], case["phase"])
        result = self.check(events, case)
        self.assertTrue(result["ok"])
        self.assertEqual(result["completed_phase"], case["phase"])
        self.assertEqual(result["folder_evidence"], {
            "source": "mailbox://test/source", "destination": "mailbox://test/destination"})
        for names, phase in ((["source"], case["phase"]),
                             (["source", "source"], case["phase"]),
                             (["source", "destination"], None)):
            with self.subTest(names=names, phase=phase):
                failed = self.check(self.folder_events(names, phase), case)
                self.assertFalse(failed["ok"])
                self.assertEqual(failed["coverage"], "none")
                self.assertIsNone(failed["completed_phase"])
        for field, value in (("actualStore", "maildir"),
                             ("backend", "mork"),
                             ("folderURI", "mailbox://other/destination")):
            changed = copy.deepcopy(events)
            payload = {**self.folder, "folderURI": "mailbox://test/destination", field: value}
            changed[6] = self.diag("FOLDER", payload)
            if field == "folderURI":
                changed[5] = self.diag("STORE_CONTRACT", {**self.contract, "folderURI": value})
            with self.subTest(field=field):
                result = self.check(changed, case)
                self.assertFalse(result["ok"])
                if field == "folderURI":
                    self.assertIn("declared fixture folders do not share a parent", result["errors"])

    def test_workflow_requires_declared_folder_scope_without_fabricated_phase(self):
        case = {**self.case, "folder_roles": {
            "first": "listFirst", "second": "listSecond", "outside": "listOutside"}}
        good = self.check(self.folder_events(list(case["folder_roles"].values())), case)
        self.assertTrue(good["ok"])
        self.assertIsNone(good["last_phase"])
        self.assertIsNone(good["completed_phase"])
        self.assertFalse(self.check(self.folder_events(["listFirst", "listSecond"]), case)["ok"])

    def test_first_failure_and_observed_phase_never_certify_later_coverage(self):
        case = {**self.case, "phase": "local-copy-verified",
                "folder_roles": {"source": "source", "destination": "destination"}}
        events = self.folder_events(["source", "destination"])
        failure = {"action": "test_status", "test": case["file"], "status": "FAIL",
                   "expected": "PASS", "subtest": "source property value", "message": "wrong value"}
        events[-3:-3] = [failure, self.diag("PHASE", {"phase": case["phase"]}),
                         {"action": "log", "level": "ERROR", "message": "later error"}]
        result = self.check(events, case)
        self.assertEqual(result["first_failure"], failure)
        self.assertEqual(result["last_phase"], case["phase"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["coverage"], "none")
        self.assertIsNone(result["completed_phase"])

    def test_changed_or_missing_inputs_cannot_certify_completed_phase(self):
        case = {**self.case, "phase": "local-copy-verified"}
        events = self.folder_events(["source"], case["phase"])
        config = {"source": str(self.root), "objdir": str(self.root), "python": "python"}

        def execute(argv, **kwargs):
            raw = Path(argv[argv.index("--log-raw") + 1])
            raw.write_text("".join(json.dumps(e) + "\n" for e in events))
            return SimpleNamespace(returncode=0)

        for name, after, disposition in (("changed", {"input": "new"}, "failed"),
                                         ("missing", OSError("input removed"), "blocked")):
            output = self.root / name
            output.mkdir()
            with (
                patch.object(runner, "prepare", return_value=(self.root / "manual.toml", [])),
                patch.object(runner, "digest", side_effect=[{"input": "old"}, after]),
                patch.object(runner.subprocess, "run", execute),
            ):
                result = runner.run_case(config, case, output)
            self.assertFalse(result["ok"])
            self.assertEqual(result["disposition"], disposition)
            self.assertEqual(result["coverage"], "none")
            self.assertIsNone(result["completed_phase"])

    def test_invalid_folder_role_declarations_block_before_manifest_read(self):
        for roles in (["source"], {"one": "source", "two": "source"},
                      {"source": "../source"}, {"source": 1}):
            with self.subTest(roles=roles), self.assertRaisesRegex(ValueError, "folder roles"):
                runner.prepare({"source": str(self.root)}, {**self.case, "folder_roles": roles})


if __name__ == "__main__":
    unittest.main()
