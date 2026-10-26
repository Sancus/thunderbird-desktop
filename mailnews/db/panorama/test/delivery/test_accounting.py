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

    def test_hyphenated_folder_diagnostics_keep_literal_and_ambiguous_identity(self):
        case = {**self.case, "folder_roles": {"fixture": "init-failure"}}
        for leaf in ("init-failure", "init%2Dfailure"):
            with self.subTest(leaf=leaf):
                result = self.check(self.folder_events([leaf]), case)
                self.assertTrue(result["ok"])
                self.assertEqual(result["folder_evidence"], {"fixture": "mailbox://test/" + leaf})
        for leaves in (["init%252Dfailure"], ["init%2Ffailure"],
                       ["init-failure", "init%2Dfailure"]):
            with self.subTest(leaves=leaves):
                result = self.check(self.folder_events(leaves), case)
                self.assertFalse(result["ok"])
                self.assertEqual(result["coverage"], "none")
                self.assertIn("missing or ambiguous folder evidence: fixture", result["errors"])

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
                      {"source": "../source"}, {"source": 1},
                      *({"source": name} for name in ("", "-init", "init-", "init--failure",
                         "init..failure", "init.-failure", "init/failure", "init\\failure",
                         "init%2Dfailure", "init%2Ffailure", "init?failure", "init#failure",
                         "init failure", "init\nfailure", "init\0failure"))):
            with self.subTest(roles=roles), self.assertRaisesRegex(ValueError, "folder roles"):
                runner.prepare({"source": str(self.root)}, {**self.case, "folder_roles": roles})


    def format_fixture(self):
        source = self.root / "comm/tests"
        source.mkdir(parents=True)
        manifest = source / "format.toml"
        manifest.write_text('''[DEFAULT]
head = ""
support-files = ["fragment.mork"]
["test_one.js"]
''', encoding="utf-8")
        for name in ("test_one.js", "fragment.mork", "reader.sys.mjs", "moz.build"):
            (source / name).write_text("fixture", encoding="utf-8")
        case = {**self.case, "id": "migration-format:unit", "backend": None, "store": None,
                "diagnostics": "format-reader", "fixture": "format-reader",
                "manifest": "tests/format.toml",
                "source_dependencies": ["tests/reader.sys.mjs", "tests/moz.build"]}
        return source, manifest, case

    def test_format_reader_requires_complete_assertions_and_no_product_claims(self):
        case = {**self.case, "backend": None, "store": None, "diagnostics": "format-reader"}
        events = self.events[:2] + self.events[5:]
        result = self.check(events, case)
        self.assertTrue(result["ok"])
        self.assertEqual(result["coverage"], "format-reader")
        self.assertEqual(result["assertion_count"], 1)
        self.assertEqual(result["folder_evidence"], {})
        variants = [events[:2] + events[3:], events[1:], events[:-1],
                    events[:2] + [self.events[2]] + events[2:],
                    events[:2] + [self.diag("PHASE", {"phase": "pretend"})] + events[2:],
                    events[:2] + [self.diag("UNKNOWN", {})] + events[2:],
                    events[:2] + [{"action": "crash"}] + events[2:]]
        for status in ("SKIP", "FAIL", "TIMEOUT"):
            wrong = copy.deepcopy(events)
            wrong[2].update(status=status, expected=status)
            variants.append(wrong)
        for wrong in variants:
            with self.subTest(events=wrong):
                rejected = self.check(wrong, case)
                self.assertFalse(rejected["ok"])
                self.assertEqual(rejected["coverage"], "none")
        extra = copy.deepcopy(events)
        extra[1]["test"] = "test_other.js"
        self.assertFalse(self.check(extra, case)["ok"])

    def test_format_reader_preflight_binds_fixtures_module_and_packaging(self):
        source, manifest, case = self.format_fixture()
        config = {"source": str(self.root)}
        _, paths = runner.prepare(config, case)
        self.assertTrue({source / n for n in ("fragment.mork", "reader.sys.mjs", "moz.build")} <= set(paths))
        for changed in ({"backend": "panorama"}, {"store": "none"}, {"phase": "fake"},
                        {"diagnostics": "backend"}, {"folder_roles": {"one": "Inbox"}},
                        {"source_dependencies": []}, {"source_dependencies": ["../escape"]}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                runner.prepare(config, {**case, **changed})
        original = manifest.read_text()
        for declaration in ('prefs = ["mail.panorama.enabled=true"]',
                            'environment = ["PANORAMA_DELIVERY_EXPECT=panorama:none"]',
                            'head = "head.js"'):
            text = original.replace('head = ""', declaration)
            manifest.write_text(text, encoding="utf-8")
            with self.subTest(declaration=declaration), self.assertRaises(ValueError):
                runner.prepare(config, case)
        manifest.write_text(original, encoding="utf-8")
        (source / "reader.sys.mjs").unlink()
        with self.assertRaisesRegex(ValueError, "blocked-dependency"):
            runner.prepare(config, case)

    def test_format_reader_unsets_lane_and_keeps_failure_then_later_result(self):
        source, _, case = self.format_fixture()
        config = {"source": str(self.root), "objdir": str(self.root / "obj"),
                  "python": "python", "evidence": str(self.root / "evidence")}
        (self.root / "obj/dist/bin").mkdir(parents=True)
        binary = "xpcshell.exe" if os.name == "nt" else "xpcshell"
        (self.root / "obj/dist/bin" / binary).write_text("fixture")
        (self.root / "obj/mozinfo.json").write_text("{}")
        calls = []
        events = self.events[:2] + self.events[5:]
        def fake_run(argv, **kwargs):
            calls.append(argv)
            for name in ("MOZ_AUTOMATION", "PANORAMA_DELIVERY_EXPECT", "PANORAMA_DELIVERY_TEST_ROOT"):
                self.assertNotIn(name, kwargs["env"])
            Path(argv[argv.index("--log-raw") + 1]).write_text(
                "".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
            return SimpleNamespace(returncode=1 if len(calls) == 1 else 0)
        with patch.dict(os.environ, {"MOZ_AUTOMATION": "1", "PANORAMA_DELIVERY_EXPECT": "mork:mbox",
                                     "PANORAMA_DELIVERY_TEST_ROOT": "stale"}), patch.object(runner.subprocess, "run", fake_run):
            summary = runner.run_batch(config, [case, {**case, "id": "migration-format:two"}])
        self.assertEqual(len(calls), 2)
        self.assertFalse(summary["ok"])
        self.assertEqual([r["coverage"] for r in summary["results"]], ["none", "format-reader"])
        self.assertEqual([r["observed"] for r in summary["results"]], ["FAIL", "PASS"])
        self.assertIsNone(summary["results"][1]["environment"]["PANORAMA_DELIVERY_EXPECT"])


    def test_news_requires_both_groups_and_completion_without_later_credit(self):
        case = {**self.case, "id": "news:panorama:mbox:Identity",
                "phase": "news-identity-verified", "folder_roles": {
                    "first": "test.subscribe.simple", "second": "test.filter"}}
        events = self.folder_events(list(case["folder_roles"].values()), case["phase"])
        good = self.check(events, case)
        self.assertTrue(good["ok"])
        self.assertEqual(set(good["folder_evidence"]), {"first", "second"})
        for names, phase in ((["test.subscribe.simple"], case["phase"]),
                             (list(case["folder_roles"].values()), None)):
            with self.subTest(names=names, phase=phase):
                result = self.check(self.folder_events(names, phase), case)
                self.assertFalse(result["ok"])
                self.assertEqual(result["coverage"], "none")
        failure = {"action": "test_status", "test": case["file"], "status": "FAIL",
                   "expected": "PASS", "message": "first header has wrong identity"}
        events.insert(3, failure)
        failed = self.check(events, case)
        self.assertEqual(failed["first_failure"], failure)
        self.assertEqual(failed["last_phase"], case["phase"])
        self.assertIsNone(failed["completed_phase"])
        self.assertEqual(failed["coverage"], "none")
        factory = self.events[:3] + [self.diag("PHASE", {"phase": "news-factory"}),
                                   failure] + self.events[-2:]
        blocked = self.check(factory, case)
        self.assertTrue(blocked["factory_blocked"])
        self.assertFalse(blocked["ok"])
        self.assertEqual(blocked["coverage"], "none")
        self.assertEqual(blocked["last_phase"], "news-factory")

    def news_fixture(self):
        source = self.root / "comm/tests"
        source.mkdir(parents=True)
        (source / "manual.toml").write_text('''[DEFAULT]
head = "head_server_setup.js head_delivery_paths.js head_delivery.js"
environment = ["PANORAMA_DELIVERY_EXPECT=panorama:mbox"]
prefs = [
  "mail.panorama.enabled=true",
  "mail.serverDefaultStoreContractID=@mozilla.org/msgstore/berkeleystore;1",
  "mail.server.default.storeContractID=@mozilla.org/msgstore/berkeleystore;1",
]
["test_one.js"]
''', encoding="utf-8")
        for name in ("head_server_setup.js", "head_delivery_paths.js", "head_delivery.js", "test_one.js"):
            (source / name).write_text("// fixture", encoding="utf-8")
        modules = {
            "mailnews/LocalAccountUtils.sys.mjs": "comm/mailnews/test/resources/LocalAccountUtils.sys.mjs",
            "mailnews/Maild.sys.mjs": "comm/mailnews/test/fakeserver/Maild.sys.mjs",
            "mailnews/Nntpd.sys.mjs": "comm/mailnews/test/fakeserver/Nntpd.sys.mjs",
            "mailnews/PromiseTestUtils.sys.mjs": "comm/mailnews/test/resources/PromiseTestUtils.sys.mjs",
            "AppInfo.sys.mjs": "testing/modules/AppInfo.sys.mjs",
            "MockRegistrar.sys.mjs": "testing/modules/MockRegistrar.sys.mjs",
        }
        for name, original in modules.items():
            for path in (self.root / original, self.root / "obj/_tests/modules" / name):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("// matching " + name, encoding="utf-8")
        for name in ("comm/mailnews/moz.build", "testing/modules/moz.build",
                     "obj/_tests/xpcshell/comm/mailnews/resources/mailShutdown.js",
                     "comm/mailnews/test/resources/mailShutdown.js",
                     "obj/dist/bin/xpcshell" + (".exe" if os.name == "nt" else ""), "obj/mozinfo.json"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture", encoding="utf-8")
        config = {"source": str(self.root), "objdir": str(self.root / "obj"), "python": "python"}
        return config, {**self.case, "id": "news:panorama:mbox:Identity"}

    def test_news_missing_or_stale_installed_dependency_blocks_before_launch(self):
        config, case = self.news_fixture()
        _, paths = runner.prepare(config, case)
        wanted = self.root / "obj/_tests/modules/mailnews/Nntpd.sys.mjs"
        self.assertIn(wanted, paths)
        self.assertIn(self.root / "comm/mailnews/test/fakeserver/Nntpd.sys.mjs", paths)
        self.assertIn(self.root / "obj/_tests/xpcshell/comm/mailnews/resources/mailShutdown.js", paths)
        for index, relative in enumerate(("obj/_tests/modules/mailnews/Nntpd.sys.mjs",
                                          "obj/_tests/modules/AppInfo.sys.mjs",
                                          "obj/_tests/xpcshell/comm/mailnews/resources/mailShutdown.js")):
            target = self.root / relative
            original = target.read_text()
            for content in (None, "// stale installed fixture"):
                if content is None:
                    target.unlink()
                else:
                    target.write_text(content)
                output = self.root / (str(index) + ("-missing" if content is None else "-stale"))
                output.mkdir()
                with patch.object(runner.subprocess, "run") as execute:
                    result = runner.run_case(config, case, output)
                execute.assert_not_called()
                self.assertEqual(result["disposition"], "blocked")
                self.assertIn("blocked-dependency:", result["observed"])
                self.assertEqual(result["coverage"], "none")
            target.write_text(original)
            self.assertIn(target, runner.prepare(config, case)[1])
        with self.assertRaisesRegex(ValueError, "folder roles"):
            runner.prepare(config, {**case, "folder_roles": {"bad": "test..filter"}})

    def test_news_launch_binds_installed_root_and_keeps_later_case_after_failure(self):
        config, case = self.news_fixture()
        config["evidence"] = str(self.root / "evidence")
        calls = []
        def execute(argv, **kwargs):
            calls.append(argv)
            self.assertNotIn("MOZ_AUTOMATION", kwargs["env"])
            self.assertEqual(kwargs["env"]["PANORAMA_DELIVERY_EXPECT"], "panorama:mbox")
            self.assertEqual(kwargs["env"]["PANORAMA_DELIVERY_TEST_ROOT"],
                             str(self.root / "obj/_tests/xpcshell/comm") + os.sep)
            self.assertEqual(Path(argv[-1]), self.root / "comm/tests/test_one.js")
            Path(argv[argv.index("--log-raw") + 1]).write_text(
                "".join(json.dumps(e) + "\n" for e in self.events), encoding="utf-8")
            return SimpleNamespace(returncode=1 if len(calls) == 1 else 0)
        with patch.dict(os.environ, {"MOZ_AUTOMATION": "1", "PANORAMA_DELIVERY_TEST_ROOT": "stale"}), patch.object(runner.subprocess, "run", execute):
            result = runner.run_batch(config, [case, {**case, "id": "news:panorama:mbox:Body"}])
        self.assertEqual(len(calls), 2)
        self.assertFalse(result["ok"])
        self.assertEqual([r["observed"] for r in result["results"]], ["FAIL", "PASS"])
        self.assertEqual([r["coverage"] for r in result["results"]], ["none", "folder"])
        hashes = result["results"][1]["hashes_before"]
        self.assertIn(str(self.root / "obj/_tests/modules/mailnews/Nntpd.sys.mjs"), hashes)
        self.assertEqual(hashes, result["results"][1]["hashes_after"])
    def test_metadata_task_requires_exact_completion_assertions_and_scope(self):
        case = {**self.case, "store": "none", "diagnostics": "backend",
                "task": "test_references"}
        backend = self.diag("BACKEND", {"expected": "panorama", "actualBackend": "panorama",
                                       "store": "none", "scope": "metadata-only"})
        def task(name, state):
            return {"action": "log", "message":
                    f"(xpcshell/head.js) | test {name} {state} (2)"}
        begin, end = task(case["task"], "pending"), task(case["task"], "finished")
        events = self.events[:2] + [backend, begin, self.events[5], end] + self.events[6:]
        self.assertTrue(self.check(events, case)["ok"])
        for index in (3, 4, 5):
            self.assertFalse(self.check(events[:index] + events[index + 1:], case)["ok"])
        for extra in (begin, end, task("test_other", "pending"), self.events[4]):
            self.assertFalse(self.check(events[:5] + [extra] + events[5:], case)["ok"])
        for data in ({"store": "mbox", "scope": "folder"}, {"store": "none"}):
            wrong = self.diag("BACKEND", {"expected": "panorama", "actualBackend": "panorama", **data})
            self.assertFalse(self.check(events[:2] + [wrong] + events[3:], case)["ok"])

    def test_named_task_preflight_binds_source_and_support_file(self):
        source = self.root / "comm/tests"
        source.mkdir(parents=True)
        (source / "manual.toml").write_text('''[DEFAULT]
head = "head.js"
environment = ["PANORAMA_DELIVERY_EXPECT=panorama:none"]
prefs = ["mail.panorama.enabled=true"]
support-files = ["fixture.sql"]
["test_one.js"]
''')
        (source / "head.js").write_text("// fixture")
        (source / "fixture.sql").write_text("-- captured layout")
        case = {**self.case, "store": "none", "diagnostics": "backend",
                "fixture": "raw-db", "task": "test_references"}
        test = source / "test_one.js"
        test.write_text("add_task(function test_references() {});")
        self.assertIn(source / "fixture.sql", runner.prepare({"source": str(self.root)}, case)[1])

        manifest = source / "manual.toml"
        original = manifest.read_text()
        manifest.write_text(original.replace('"fixture.sql"', '"data/**"'))
        (source / "data").mkdir()
        support = source / "data/row.sql"
        support.write_text("-- observed fragment")
        self.assertIn(support, runner.prepare({"source": str(self.root)}, case)[1])
        support.unlink()
        with self.assertRaisesRegex(ValueError, "empty support-file glob"):
            runner.prepare({"source": str(self.root)}, case)
        manifest.write_text(original)
        for text in ("", "add_task(function test_wrong() {});",
                     "add_task({skip_if: true}, function test_references() {});",
                     "add_task(function test_references() {}); add_task(function test_extra() {});"):
            test.write_text(text)
            with self.assertRaisesRegex(ValueError, "named task"):
                runner.prepare({"source": str(self.root)}, case)
        test.write_text("add_task(function test_references() {});")
        (source / "fixture.sql").unlink()
        with self.assertRaisesRegex(ValueError, "blocked-dependency"):
            runner.prepare({"source": str(self.root)}, case)

    def test_large_case_timeout_is_explicit_and_never_success(self):
        case = {**self.case, "task": "test_references", "timeout_seconds": 1800}
        config = {"source": str(self.root), "objdir": str(self.root / "obj"),
                  "python": "python", "timeout_seconds": 600}
        def timeout(argv, **kwargs):
            self.assertEqual(kwargs["timeout"], 1800)
            self.assertEqual(argv[argv.index("--timeout-factor") + 1], "50")
            self.assertNotIn("--timeout-as-pass", argv)
            self.assertEqual(Path(argv[-1]).name, case["file"])
            raise runner.subprocess.TimeoutExpired(argv, kwargs["timeout"])
        with (patch.object(runner, "prepare", return_value=(None, [])),
              patch.object(runner, "digest", return_value={}),
              patch.object(runner.subprocess, "run", timeout)):
            record = runner.run_case(config, case, self.root)
        self.assertFalse(record["ok"])
        self.assertEqual(record["observed"], "TIMEOUT")
        self.assertEqual(record["coverage"], "none")
        self.assertEqual(record["disposition"], "failed")

    def test_registered_metadata_files_select_one_task_without_a_store(self):
        catalog = json.loads((runner.HERE / "cases.json").read_text())
        comm = runner.HERE.parents[4]
        cases = [c for c in catalog if c.get("task")]
        self.assertEqual(len(cases), 38)
        self.assertEqual(len({c["id"] for c in catalog}), 163)
        for case in cases:
            manifest = comm / case["manifest"]
            doc = runner.tomllib.loads(manifest.read_text())
            for section in (doc["DEFAULT"], doc[case["file"]]):
                self.assertFalse(set(section) & {"skip-if", "fail-if", "run-if", "disabled", "expected"})
            text = (manifest.parent / case["file"]).read_text()
            names = runner.re.findall(r"\badd_task\s*\(\s*(?:async\s+)?function\s+(\w+)\s*\(", text)
            self.assertEqual(names, [case["task"]])
            self.assertEqual((case["backend"], case["store"], case["fixture"]),
                             ("panorama", "none", "raw-db"))
            if "Count" in case["id"]:
                self.assertEqual(case["timeout_seconds"], 1800)

    def test_discovery_selector_phase_and_nested_target_bound_coverage(self):
        case = {**self.case, "id": "imap:panorama:mbox:DiscoveryRepeat", "selector": "repeat",
                "phase": "imap-discovery-repeat-verified", "folder_roles": {"target": "DeliveryChild"}}
        contract = {**self.contract, "folderURI": "imap://test/DeliveryParent/DeliveryChild"}
        folder = {**self.folder, **contract}
        mode = self.diag("IMAP_FIXTURE", {"backend": "panorama", "store": "mbox",
                         "mode": "preconfigured-store", "discoveryCase": "repeat"})
        events = self.events[:3] + [mode, self.diag("STORE_CONTRACT", contract),
                 self.diag("FOLDER", folder), self.diag("PHASE", {"phase": case["phase"]})] + self.events[5:]
        self.assertTrue(self.check(events, case)["ok"])
        for index in (3, 4, 5, 6):
            self.assertFalse(self.check(events[:index] + events[index + 1:], case)["ok"])
        wrong = copy.deepcopy(events)
        wrong[3] = self.diag("IMAP_FIXTURE", {"backend": "panorama", "store": "mbox",
                            "mode": "preconfigured-store", "discoveryCase": "child"})
        self.assertFalse(self.check(wrong, case)["ok"])
        wrong = copy.deepcopy(events)
        wrong[4] = self.diag("STORE_CONTRACT", {**contract, "folderURI": "imap://test/DeliveryParent"})
        wrong[5] = self.diag("FOLDER", {**folder, "folderURI": "imap://test/DeliveryParent"})
        self.assertFalse(self.check(wrong, case)["ok"])
        failed = events[:7] + [{"action": "test_status", "test": case["file"], "status": "FAIL"}] + events[7:]
        result = self.check(failed, case)
        self.assertFalse(result["ok"])
        self.assertIsNone(result["completed_phase"])
        self.assertEqual(result["coverage"], "none")

    def test_discovery_catalog_is_explicit_manual_selection_in_all_four_lanes(self):
        catalog = json.loads((runner.HERE / "cases.json").read_text())
        rows = [c for c in catalog if c.get("selector")]
        self.assertEqual(len(rows), 20)
        self.assertEqual({(c["backend"], c["store"], c["selector"]) for c in rows},
                         {(b, s, n) for b in ("mork", "panorama") for s in ("mbox", "maildir")
                          for n in ("child", "nested", "repeat", "online-name", "delimiter")})
        comm = runner.HERE.parents[4]
        for case in rows:
            self.assertNotIn("task", case)
            self.assertEqual(case["reference_only"], case["backend"] == "mork")
            self.assertEqual(case["folder_roles"], {"target": "DeliveryParent" if case["selector"] == "child" else "DeliveryChild"})
            doc = runner.tomllib.loads((comm / case["manifest"]).read_text())
            self.assertEqual(set(doc), {"DEFAULT", "test_panoramaDeliveryDiscovery.js"})
            self.assertIn("mail.test.panorama.discovery_case=" + case["selector"], doc["DEFAULT"]["prefs"])

    def test_discovery_preflight_binds_selector_and_installed_fixture_bytes(self):
        import shutil
        comm = runner.HERE.parents[4]
        source = self.root / "source"
        obj = self.root / "obj"
        config = {"source": str(source), "objdir": str(obj)}
        rows = [c for c in json.loads((runner.HERE / "cases.json").read_text()) if c.get("selector")]
        self.assertEqual(len(rows), 20)
        names = [c["manifest"] for c in rows] + [
            "mailnews/imap/test/unit/" + n for n in
            ("test_panoramaDeliveryDiscovery.js", "head_server.js", "head_imap_maildir.js")]
        names += ["mailnews/db/panorama/test/xpcshell/" + n for n in
                  ("head_delivery.js", "head_delivery_paths.js")]
        modules = {folder + "/" + name + ".sys.mjs": name + ".sys.mjs"
                   for folder, nameset in (
                       ("resources", ("IMAPpump", "LocalAccountUtils", "MailTestUtils", "MessageGenerator", "PromiseTestUtils")),
                       ("fakeserver", ("Maild", "Imapd", "Auth", "Smtpd"))) for name in nameset}
        names += ["mailnews/test/" + n for n in modules] + ["mailnews/moz.build", "mailnews/test/resources/mailShutdown.js"]
        for name in names:
            target = source / "comm" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(comm / name, target)
        for relative, name in modules.items():
            target = obj / "_tests/modules/mailnews" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / "comm/mailnews/test" / relative, target)
        for name in ("AppInfo.sys.mjs", "MockRegistrar.sys.mjs", "moz.build"):
            target = source / "testing/modules" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("// synthetic Gecko dependency; no JS execution")
            if name != "moz.build":
                (obj / "_tests/modules" / name).write_bytes(target.read_bytes())
        shutdown = obj / "_tests/xpcshell/comm/mailnews/resources/mailShutdown.js"
        shutdown.parent.mkdir(parents=True)
        shutil.copyfile(source / "comm/mailnews/test/resources/mailShutdown.js", shutdown)
        for case in rows:
            self.assertEqual(runner.prepare(config, case)[0].name, Path(case["manifest"]).name)
        with self.assertRaisesRegex(ValueError, "selector differs"):
            runner.prepare(config, {**rows[0], "selector": "repeat"})
        installed = obj / "_tests/modules/mailnews/Imapd.sys.mjs"
        installed.write_text("stale installed fake server")
        with self.assertRaisesRegex(ValueError, "fixture differs"):
            runner.prepare(config, rows[0])
        installed.unlink()
        with self.assertRaisesRegex(ValueError, "blocked-dependency"):
            runner.prepare(config, rows[0])



    def initializer_fixture(self):
        config, case = self.news_fixture()
        case.update(id="compatibility:panorama:mbox:FolderInitParentConflict",
                    tasks=["test_first", "test_second"], setups=["setupFolders"],
                    requires_non_debug=True)
        source = self.root / "comm/tests"
        (source / "test_one.js").write_text(
            "add_setup(function setupFolders() {});\n"
            "add_task(function test_first() {});\nadd_task(async function test_second() {});")
        for relative in ("mailnews/test/resources/MessageGenerator.sys.mjs",
                         "obj/_tests/modules/mailnews/MessageGenerator.sys.mjs"):
            path = self.root / ("comm/" + relative if not relative.startswith("obj/") else relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("// matching generator")
        for relative in ("xpcom/base/nsDebug.h", "xpcom/base/nsDebugImpl.cpp",
                         "testing/xpcshell/runxpcshelltests.py", "obj/config.status"):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("// synthetic bound input")
        (self.root / "obj/mozinfo.json").write_text('{"debug": false}')
        return config, case

    def initializer_events(self, case):
        events = self.events[:5]
        for name in case["tasks"]:
            for state in ("pending", "finished"):
                events.append({"action": "log", "message":
                               f"(xpcshell/head.js) | test {name} {state} (2)"})
                if state == "pending":
                    events.append(self.events[5])
        return events + self.events[6:]

    def test_initializer_requires_all_named_tasks_and_assertions(self):
        case = {**self.case, "tasks": ["test_first", "test_second"], "setups": ["setupFolders"]}
        events = self.initializer_events(case)
        self.assertTrue(self.check(events, case)["ok"])
        for index in range(5, 11):
            with self.subTest(missing=index):
                rejected = self.check(events[:index] + events[index + 1:], case)
                self.assertFalse(rejected["ok"])
                self.assertEqual(rejected["coverage"], "none")
        for extra in (events[5], {"action": "log", "message":
                      "(xpcshell/head.js) | test test_extra pending (2)"}):
            self.assertFalse(self.check(events[:6] + [extra] + events[6:], case)["ok"])
        wrong = copy.deepcopy(events)
        wrong[6] = {**wrong[6], "status": "FAIL", "message": "fault witness missing"}
        failed = self.check(wrong, case)
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["first_failure"], wrong[6])
        self.assertEqual(failed["coverage"], "none")

    def test_initializer_preflight_binds_modules_mode_and_named_source(self):
        config, case = self.initializer_fixture()
        _, paths = runner.prepare(config, case)
        required = ["testing/modules/MockRegistrar.sys.mjs",
                    "obj/_tests/modules/MockRegistrar.sys.mjs",
                    "comm/mailnews/test/resources/MessageGenerator.sys.mjs",
                    "obj/_tests/modules/mailnews/MessageGenerator.sys.mjs",
                    "testing/xpcshell/runxpcshelltests.py", "xpcom/base/nsDebug.h",
                    "obj/mozinfo.json", "obj/config.status"]
        self.assertTrue({self.root / p for p in required} <= set(paths))
        test = self.root / "comm/tests/test_one.js"
        original = test.read_text()
        for text in (original.replace("test_second", "test_wrong"),
                     original.replace("setupFolders", "setupWrong"),
                     original + "add_task(function test_extra() {});",
                     original.replace("function test_first", "function")):
            test.write_text(text)
            with self.subTest(source=text), self.assertRaisesRegex(ValueError, "named tasks/setup"):
                runner.prepare(config, case)
        test.write_text(original)
        for relative in ("obj/_tests/modules/MockRegistrar.sys.mjs",
                         "obj/_tests/modules/mailnews/MessageGenerator.sys.mjs"):
            target = self.root / relative
            content = target.read_text()
            for stale in (None, "// stale installed module"):
                if stale is None:
                    target.unlink()
                else:
                    target.write_text(stale)
                with self.subTest(path=relative, stale=stale), self.assertRaisesRegex(ValueError, "blocked-dependency"):
                    runner.prepare(config, case)
            target.write_text(content)

    def test_initializer_catalog_preflight_accepts_literal_folder_roles(self):
        import shutil
        config, _ = self.initializer_fixture()
        comm = runner.HERE.parents[4]
        source = Path(config["source"]) / "comm"
        catalog = json.loads((runner.HERE / "cases.json").read_text())
        cases = [c for c in catalog if c["file"].startswith("test_deliveryCompatibilityFolderInit")]
        self.assertEqual(len(cases), 8)
        control = next(c for c in catalog if c["id"] == "local:panorama:mbox:Move")
        for case in cases + [control]:
            manifest = comm / case["manifest"]
            doc = runner.tomllib.loads(manifest.read_text())
            paths = [manifest] + [manifest.parent / n for n in doc if n != "DEFAULT"]
            paths += [manifest.parent / n for n in doc["DEFAULT"]["head"].split()]
            paths += [manifest.parent / n for n in doc["DEFAULT"].get("support-files", [])]
            for original in paths:
                target = source / original.resolve().relative_to(comm)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original, target)
        module = "mailnews/test/resources/MessageGenerator.sys.mjs"
        shutil.copyfile(comm / module, source / module)
        shutil.copyfile(comm / module, Path(config["objdir"]) / "_tests/modules/mailnews/MessageGenerator.sys.mjs")
        with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=7)) as execute:
            for index, case in enumerate(cases + [control]):
                with self.subTest(case=case["id"]):
                    manifest, paths = runner.prepare(config, case)
                    selected = manifest.parent / case["file"]
                    self.assertIn(selected, paths)
                    self.assertEqual(selected.read_bytes(), (comm / case["manifest"]).with_name(case["file"]).read_bytes())
                    output = self.root / ("actual-" + str(index))
                    output.mkdir()
                    execute.reset_mock()
                    record = runner.run_case(config, case, output)
                    execute.assert_called_once()
                    self.assertEqual(execute.call_args.args[0][-1], str(selected))
                    self.assertEqual(record["exit_code"], 7)
                    self.assertEqual(record["disposition"], "failed")
                    self.assertEqual(record["coverage"], "none")
            for index, roles in enumerate(({"fixture": "init/failure"},
                    {"fixture": "init%2Dfailure"}, {"fixture": "init--failure"},
                    {"first": "init-failure", "second": "init-failure"})):
                with self.subTest(invalid=roles):
                    output = self.root / ("invalid-" + str(index))
                    output.mkdir()
                    execute.reset_mock()
                    record = runner.run_case(config, {**cases[0], "folder_roles": roles}, output)
                    execute.assert_not_called()
                    self.assertEqual(record["disposition"], "blocked")
                    self.assertIsNone(record["exit_code"])
                    self.assertEqual(record["coverage"], "none")
                    self.assertIn("folder roles", " ".join(record["errors"]))

    def test_initializer_unknown_or_debug_mode_refuses_before_launch(self):
        config, case = self.initializer_fixture()
        for index, info in enumerate(({}, {"debug": True}, {"debug": "false"}, {"debug": 0})):
            (self.root / "obj/mozinfo.json").write_text(json.dumps(info))
            output = self.root / str(index)
            output.mkdir()
            with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as execute:
                result = runner.run_case(config, case, output)
            execute.assert_not_called()
            self.assertEqual(result["disposition"], "blocked")
            self.assertIn("held-build-mode", " ".join(result["errors"]))
            self.assertEqual(result["coverage"], "none")

    def test_initializer_raw_assertion_cannot_hide_behind_success(self):
        config, case = self.initializer_fixture()
        events = self.initializer_events(case)
        for index, (stream, diagnostic) in enumerate((("stderr", ""),
                ("stderr", "###!!! ASSERTION: Error: missing URI\n"),
                ("stdout", "###!!! ASSERTION: Error: missing URI\n"))):
            output = self.root / ("raw-" + str(index))
            output.mkdir()
            def execute(argv, **kwargs):
                Path(argv[argv.index("--log-raw") + 1]).write_text(
                    "".join(json.dumps(e) + "\n" for e in events))
                kwargs[stream].write(diagnostic.encode())
                return SimpleNamespace(returncode=0)
            with patch.object(runner.subprocess, "run", execute):
                result = runner.run_case(config, case, output)
            self.assertEqual(result["ok"], not bool(diagnostic))
            self.assertEqual(result["build_mode"]["debug"], False)
            self.assertEqual(result["build_mode"]["harness_XPCOM_DEBUG_BREAK"], "stack-and-abort")
            if diagnostic:
                self.assertEqual(result["coverage"], "none")
                self.assertIn("ASSERTION", result["first_failure"]["message"])
        output = {"action": "process_output", "data": "###!!! ASSERTION: Error: missing URI"}
        self.check(events[:6] + [output] + events[6:], case)
        raw_logs = (self.root / "empty.stdout", self.root / "empty.stderr")
        for path in raw_logs:
            path.write_text("")
        rejected = runner.check_log(self.log, case, raw_logs=raw_logs)
        self.assertFalse(rejected["ok"])
        self.assertIn("raw assertion diagnostic in non-DEBUG control", rejected["errors"])

    def test_initializer_catalog_has_eight_file_store_cases_and_five_tasks_per_store(self):
        catalog = json.loads((runner.HERE / "cases.json").read_text())
        names = {"FolderInitFailure": (["test_failedDescendantKeepsRowsBodiesAndExistingChild"], []),
                 "FolderInitIdentity": (["test_reusesCachedChildWithoutDuplicateAttachment"], []),
                 "FolderInitConflict": (["test_rejectsConflictingLiveIdentity"], []),
                 "FolderInitParentConflict": (["test_rejectsCachedChildWithConflictingParent",
                                              "test_recursiveConflictPreservesCachedSubtree"], ["setupFolders"])}
        rows = [c for c in catalog if c["file"].startswith("test_deliveryCompatibilityFolderInit")]
        self.assertEqual(len(catalog), 163)
        self.assertEqual(len({c["id"] for c in catalog}), 163)
        self.assertEqual(len(rows), 8)
        for store in ("mbox", "maildir"):
            lane = [c for c in rows if c["store"] == store]
            self.assertEqual({c["id"] for c in lane},
                             {"compatibility:panorama:" + store + ":" + n for n in names})
            self.assertEqual(sum(len(c["tasks"]) for c in lane), 5)
            for case in lane:
                name = case["id"].rsplit(":", 1)[1]
                self.assertEqual((case["tasks"], case["setups"]), names[name])
                self.assertEqual(case["backend"], "panorama")
                self.assertEqual(case["readiness"], "pending-product")
                self.assertEqual(case["fixture"], "preconfigured-store")
                self.assertNotIn("task", case)
                self.assertEqual(case.get("requires_non_debug", False), name == "FolderInitParentConflict")
                comm = runner.HERE.parents[4]
                manifest = comm / case["manifest"]
                doc = runner.tomllib.loads(manifest.read_text())
                text = (manifest.parent / case["file"]).read_text()
                for kind, expected in (("task", case["tasks"]), ("setup", case["setups"])):
                    actual = runner.re.findall(r"\badd_" + kind + r"\s*\(\s*(?:async\s+)?function\s+(\w+)\s*\(", text)
                    self.assertEqual(actual, expected)
                for section in (doc["DEFAULT"], doc[case["file"]]):
                    self.assertFalse(set(section) & {"skip-if", "fail-if", "run-if", "disabled", "expected"})
                support = {(manifest.parent / p).resolve() for p in doc["DEFAULT"]["support-files"]}
                required = {comm / p for p in (
                    "mailnews/base/src/nsMsgDBFolder.cpp", "mailnews/base/src/nsMsgDBFolder.h",
                    "mailnews/base/src/FolderLookupService.cpp", "mailnews/base/src/FolderLookupService.h",
                    "mailnews/local/src/components.conf", "mailnews/local/src/nsLocalMailFolder.cpp",
                    "mailnews/local/src/nsLocalMailFolder.h", "mailnews/db/panorama/src/FolderDatabase.cpp",
                    "mailnews/db/panorama/src/FolderDatabase.h", "mailnews/local/src/nsMsgBrkMBoxStore.cpp",
                    "mailnews/local/src/nsMsgMaildirStore.cpp",
                    "mailnews/local/src/nsMsgBrkMBoxStore.h", "mailnews/local/src/nsMsgMaildirStore.h",
                    "mailnews/local/src/nsMsgLocalStoreUtils.cpp", "mailnews/local/src/nsMsgLocalStoreUtils.h",
                    "mailnews/base/src/nsMsgAccountManager.cpp", "mailnews/base/src/nsMsgAccountManager.h",
                    "mailnews/base/src/nsMsgIncomingServer.cpp", "mailnews/base/src/nsMsgIncomingServer.h",
                    "mailnews/db/panorama/src/DatabaseCore.cpp", "mailnews/db/panorama/src/DatabaseCore.h",
                    "mailnews/base/public/nsIMsgFolder.idl", "mailnews/base/public/nsIFolderLookupService.idl")}
                self.assertTrue(required <= support, required - support)
                self.assertTrue(all(p.is_file() and p.is_relative_to(comm) for p in support))
                self.assertNotIn(manifest.name, (manifest.parent.parent / "moz.build").read_text())



    def raw_task_case(self):
        return {**self.case, "backend": "panorama", "store": "none",
                "diagnostics": "backend", "fixture": "raw-db",
                "tasks": ["test_first", "test_second"], "anonymous_setup": True}

    def raw_task_events(self, case):
        def marker(name, state):
            return {"action": "log", "message":
                    f"(xpcshell/head.js) | test{name} {state} (2)"}
        events = self.events[:2] + [marker("", "pending"), self.events[5],
                 self.diag("BACKEND", {"expected": "panorama", "actualBackend": "panorama",
                                      "store": "none", "scope": "metadata-only"}),
                 marker("", "finished")]
        for name in case["tasks"]:
            events += [marker(" " + name, "pending"), self.events[5], marker(" " + name, "finished")]
        return events + self.events[6:]

    def test_raw_plural_requires_setup_backend_every_task_and_file_completion(self):
        case = self.raw_task_case()
        events = self.raw_task_events(case)
        self.assertTrue(self.check(events, case)["ok"])
        for index in range(len(events)):
            with self.subTest(missing=index):
                result = self.check(events[:index] + events[index + 1:], case)
                self.assertFalse(result["ok"])
                self.assertEqual(result["coverage"], "none")
        for index in (2, 5, 6, 8):
            self.assertFalse(self.check(events[:index] + [events[index]] + events[index:], case)["ok"])
        wrong = copy.deepcopy(events)
        wrong[4] = self.diag("BACKEND", {"expected": "panorama", "actualBackend": "panorama"})
        self.assertFalse(self.check(wrong, case)["ok"])
        moved = events[:4] + events[5:6] + [events[4]] + events[6:]
        self.assertFalse(self.check(moved, case)["ok"])
        wrong = copy.deepcopy(events)
        wrong[7]["status"] = "SKIP"
        self.assertFalse(self.check(wrong, case)["ok"])
        wrong[7]["status"] = "FAIL"
        self.assertEqual(self.check(wrong, case)["first_failure"], wrong[7])

    def test_raw_plural_preflight_rejects_undeclared_or_conditional_setup(self):
        source = self.root / "comm/tests"
        source.mkdir(parents=True)
        (source / "manual.toml").write_text('[DEFAULT]\nhead = "head.js"\n'
            'environment = ["PANORAMA_DELIVERY_EXPECT=panorama:none"]\n'
            'prefs = ["mail.panorama.enabled=true"]\n["test_one.js"]\n')
        (source / "head.js").write_text("// source head")
        runtime = self.root / "testing/xpcshell/head.js"
        runtime.parent.mkdir(parents=True)
        runtime.write_text("// pinned harness receipt input")
        case = self.raw_task_case()
        test = source / case["file"]
        text = ("add_setup(function () {});\nadd_task(function test_first() {});\n"
                "add_task(async function test_second() {});")
        test.write_text(text)
        self.assertIn(runtime, runner.prepare({"source": str(self.root)}, case)[1])
        for bad in (text.replace("function ()", "function setupWrong()"),
                    text + "add_setup(function () {});", text.replace("test_second", "test_wrong"),
                    text.replace("add_setup(function", "add_setup({skip_if: true}, function")):
            test.write_text(bad)
            with self.subTest(source=bad), self.assertRaisesRegex(ValueError, "named tasks/setup"):
                runner.prepare({"source": str(self.root)}, case)
        test.write_text(text)
        for changed in ({"anonymous_setup": False}, {"setups": ["setupFolders"]},
                        {"backend": "mork"}, {"task": "test_first"}):
            with self.subTest(case=changed), self.assertRaises(ValueError):
                runner.prepare({"source": str(self.root)}, {**case, **changed})
        runtime.unlink()
        with self.assertRaisesRegex(ValueError, "blocked-dependency"):
            runner.prepare({"source": str(self.root)}, case)

    def test_new_raw_catalog_and_view_lanes_are_exact_manual_cases(self):
        catalog = json.loads((runner.HERE / "cases.json").read_text())
        self.assertEqual(len(catalog), 163)
        self.assertEqual(len({c["id"] for c in catalog}), 163)
        expected = {
            "core:Publication": ["test_publishCommittedMessageOnce",
                "test_folderFilteredEventsUseDatabaseIdentity", "test_tagThenReadPublishesEachMessageOnce",
                "test_tagChangesPreserveFlaggedMembership", "test_tagChangesKeepReadMessagesOutOfUnreadView"],
            "search:panorama:none:ConversationIngestion": ["test_orderedCrossFolderIngestion",
                "test_replyBeforeParentIngestion", "test_siblingsWithMissingParent", "test_siblingsThenParentArrival"]}
        comm = runner.HERE.parents[4]
        for case in [c for c in catalog if c["id"] in expected]:
            self.assertEqual(case["tasks"], expected[case["id"]])
            self.assertIs(case["anonymous_setup"], True)
            self.assertEqual((case["backend"], case["store"], case["fixture"]), ("panorama", "none", "raw-db"))
            source = (comm / case["manifest"]).parent / case["file"]
            self.assertEqual(runner.re.findall(r"add_task\s*\(\s*(?:async\s+)?function\s+(\w+)", source.read_text()), case["tasks"])
            events = self.raw_task_events(case)
            for event in events:
                if "test" in event:
                    event["test"] = case["file"]
                if event["action"] == "suite_start":
                    event["tests"] = {case["manifest"]: [case["file"]]}
            self.assertTrue(self.check(events, case)["ok"])
            self.assertFalse(self.check(events[:-2], case)["ok"])
        ids = {"workflows:panorama:mbox:SingleFolderIdentity",
               "workflows:panorama:maildir:SingleFolderIdentity", "workflows:mork:mbox:CrossFolderIdentity"}
        rows = [c for c in catalog if c["id"] in ids]
        self.assertEqual({c["id"] for c in rows}, ids)
        for case in rows:
            doc = runner.tomllib.loads((comm / case["manifest"]).read_text())
            self.assertIn(case["file"], doc)
            self.assertNotIn("task", case)
            self.assertNotIn("tasks", case)
            self.assertTrue(case["folder_roles"])
            self.assertEqual(case["readiness"], "pending-product")
            self.assertFalse(set(doc[case["file"]]) & {"skip-if", "fail-if", "disabled"})


    def test_registered_raw_and_view_cases_pass_real_preflight_before_mock_launch(self):
        import shutil
        config, _ = self.initializer_fixture()
        comm = runner.HERE.parents[4]
        target = Path(config["source"]) / "comm"
        runtime = Path(config["source"]) / "testing/xpcshell/head.js"
        runtime.write_text("// synthetic harness dependency; no xpcshell execution")
        ids = {"core:Publication", "search:panorama:none:ConversationIngestion",
               "workflows:panorama:mbox:SingleFolderIdentity",
               "workflows:panorama:maildir:SingleFolderIdentity", "workflows:mork:mbox:CrossFolderIdentity"}
        catalog = json.loads((runner.HERE / "cases.json").read_text())
        rows = [c for c in catalog if c["id"] in ids]
        self.assertEqual({c["id"] for c in rows}, ids)
        for case in rows:
            manifest = comm / case["manifest"]
            doc = runner.tomllib.loads(manifest.read_text())
            paths = [manifest] + [manifest.parent / n for n in doc if n != "DEFAULT"]
            paths += [manifest.parent / n for n in doc["DEFAULT"]["head"].split()]
            paths += [manifest.parent / n for n in doc["DEFAULT"].get("support-files", [])]
            paths += [comm / n for n in case["source_dependencies"]]
            for original in paths:
                copy_to = target / original.resolve().relative_to(comm)
                copy_to.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(original, copy_to)
        with patch.object(runner.subprocess, "run", return_value=SimpleNamespace(returncode=7)) as launch:
            for index, case in enumerate(rows):
                manifest, paths = runner.prepare(config, case)
                self.assertIn(manifest.parent / case["file"], paths)
                self.assertTrue({target / n for n in case["source_dependencies"]} <= set(paths))
                output = self.root / ("registration-" + str(index))
                output.mkdir()
                launch.reset_mock()
                result = runner.run_case(config, case, output)
                launch.assert_called_once()
                self.assertEqual(result["exit_code"], 7)
                self.assertEqual(result["coverage"], "none")
        missing = target / rows[-1]["source_dependencies"][0]
        missing.unlink()
        with self.assertRaisesRegex(ValueError, "blocked-dependency"):
            runner.prepare(config, rows[-1])

if __name__ == "__main__":
    unittest.main()
