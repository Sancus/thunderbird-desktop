# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from marionette_harness import MarionetteTestCase
from mozprofile import Profile


class TestPanoramaSearchRebuild(MarionetteTestCase):
    """Resume the real retained trial corpus across an ordinary application exit."""

    def setUp(self):
        super().setUp()
        self._fixture_mutation_started = False
        if self.testvars is None or self.testvars == {}:
            self.skipTest("Requires --testvars from the retained S716 xpcshell fixture")
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.instance_prefs = self.marionette.instance.prefs
        self.capabilities = dict(self.marionette.requested_capabilities)
        self.initial_profile = self.marionette.instance.profile
        self.initial_profile_restore = self.initial_profile.restore
        self.trial_profile = None
        self.held = []
        self.placeholders = {}
        self.saved_prefs = []
        # --testvars names the original fixture, not a --profile clone.
        self.fixture = dict(self.testvars)
        self.profile = Path(self.fixture["profile"]).resolve()
        self.work = self.profile / "panorama-trial-rebuild"
        self.assertEqual(
            self.fixture,
            json.loads((self.work / "fixture.json").read_text(encoding="utf-8")),
            "The declared input must be the actual retained fixture",
        )
        self.assertEqual(self.fixture["version"], 1)
        f = self.fixture
        allowed_prefs = {
            "mail.panorama.enabled",
            "mailnews.database.global.indexer.enabled",
            "purple.logging.log_ims",
            "chat.logging.cleanup",
            "security.nocertdb",
        }
        self.assertEqual({p["name"] for p in f["savedPrefs"]}, allowed_prefs)
        for pref in f["savedPrefs"]:
            self.assertIsInstance(pref["hadValue"], bool)
            self.assertIsInstance(pref["value"], bool)
            self.saved_prefs.append(pref)
        self.assertNotEqual(
            Path(self.initial_profile.profile).resolve(),
            self.profile,
            "The disposable runner profile is separate from the retained corpus",
        )
        # Cleanup owns restoration only after the first lifecycle change begins.
        self._fixture_mutation_started = True
        self.stop()
        # The public setter cleans its old Profile. Keep that disposable profile
        # available for restoration, and never let Profile cleanup remove inputs.
        self.initial_profile.restore = False
        self.marionette.instance.prefs = {
            **(self.instance_prefs or {}),
            "mail.panorama.enabled": True,
            "mailnews.database.global.indexer.enabled": True,
            "purple.logging.log_ims": True,
            "chat.logging.cleanup": False,
            "security.nocertdb": True,
        }
        self.trial_profile = Profile(
            profile=str(self.profile),
            restore=False,
            **self.marionette.instance.profile_args,
        )
        self.assertFalse(self.trial_profile.create_new)
        self.marionette.instance.profile = self.trial_profile
        self.assertIs(self.marionette.instance.profile, self.trial_profile)
        self.marionette.start_session(capabilities=self.capabilities)
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.profile = Path(
            self.marionette.execute_script("return Services.dirsvc.get('ProfD', Ci.nsIFile).path;")
        ).resolve()
        self.assertEqual(Path(self.fixture["profile"]).resolve(), self.profile)
        self.work = self.profile / "panorama-trial-rebuild"
        self.validate_fixture()
        self.assert_identity()
        self.assert_source_hashes()
        self.journal_hash = self.digest(Path(self.fixture["journalPath"]))
        self.assert_receipt_keys()

    def cleanTest(self):
        """Use Marionette's actual end hook, including a failed setUp."""
        try:
            if getattr(self, "_fixture_mutation_started", False):
                self.restore_fixture()
        finally:
            super().cleanTest()

    @staticmethod
    def digest(path):
        """Hash the actual closed input bytes without copying the trial profile."""
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def owned_path(self, value):
        """Reject a fixture path outside this one retained test profile."""
        path = Path(value).resolve()
        self.assertTrue(path.is_relative_to(self.profile), str(path))
        return path

    def validate_fixture(self):
        """Bind fixed expected inputs before opening either disposable writer."""
        f = self.fixture
        self.assertIs(type(f["recoveryPolicyRevision"]), str)
        self.assertRegex(f["recoveryPolicyRevision"], r"\A[1-9][0-9]*\Z")
        startup_sidecar = Path(f["startupMailSidecar"])
        self.assertEqual(startup_sidecar, self.profile / f"panorama-search-{f['sourceId']}.sqlite")
        self.assertEqual(startup_sidecar, self.owned_path(f["startupMailSidecar"]))
        self.assertFalse(startup_sidecar.is_symlink())
        self.assertTrue(startup_sidecar.is_file())
        self.assertNotIn(
            startup_sidecar, {Path(row["path"]).resolve() for row in f["sourceHashes"]}
        )
        self.assertEqual(self.owned_path(f["work"]), self.work)
        for key, name in [("mailSidecar", "mail.sqlite"), ("chatSidecar", "chat.sqlite")]:
            self.assertEqual(self.owned_path(f[key]), self.work / name)
        for folder in f["folders"]:
            body = self.owned_path(folder["bodyPath"])
            if folder["heldPath"] is not None:
                held = self.owned_path(folder["heldPath"])
                self.assertIs(type(folder["id"]), int)
                self.assertGreater(folder["id"], 0)
                self.assertEqual(
                    held, self.work / "held-original-streams" / f"{folder['id']}.mbox"
                )
                self.assertEqual(Path(folder["heldPath"]), held)
                self.assertEqual(Path(folder["bodyPath"]), body)
                self.assertFalse(held.is_symlink())
                self.assertFalse(body.is_symlink())
                self.assertTrue(held.is_file())
                self.assertTrue(body.is_file())
                self.assertEqual(body.stat().st_size, 0)
                self.assertEqual(
                    self.digest(body),
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                )
                expected = next(
                    row["sha256"]
                    for row in f["sourceHashes"]
                    if Path(row["path"]).resolve() == held
                )
                self.assertEqual(self.digest(held), expected)
                placeholder = body.stat()
                self.placeholders[body] = (placeholder.st_dev, placeholder.st_ino)
                self.held.append((body, held, expected))
        self.assertEqual(len(f["folders"]), 4)
        self.assertEqual(len(self.held), 2)
        self.assertEqual(len(f["mail"]), 7)
        self.mail_ids = {row["id"] for row in f["mail"]}
        self.assertEqual(len(self.mail_ids), 7)
        self.assertTrue(all(isinstance(key, str) and key.isdecimal() for key in self.mail_ids))
        self.unavailable = {row["id"] for row in f["mail"] if not row["bodyReady"]}
        self.assertEqual(len(self.unavailable), 3)
        copies = [row for row in f["mail"] if row["kind"] == "mime-copy"]
        self.assertEqual(len(copies), 2)
        self.assertEqual({row["messageId"] for row in copies}, {"s716-shared@example.invalid"})
        self.assertEqual(len({row["folderId"] for row in copies}), 2)
        self.assertEqual(len({row["folderURI"] for row in copies}), 2)
        self.assertTrue(all(row["bodyReady"] for row in copies))
        self.assertEqual(f["recovered"]["records"], 6)
        self.assertEqual(f["recovered"]["eligible"], 2)
        self.assertEqual(f["recovered"]["excludedRowIds"], [34, 35])
        self.assertEqual(f["recovered"]["body"], "\ufeffrecovered e\u0301 \U0001f600 body\0tail")
        self.assertEqual(f["chat"]["bodyNeedles"], ["s716chatfirst", "s716chatsecond"])
        self.assertEqual(
            f["chat"]["expectedBody"], "sender: s716chatfirst\n\nsender: s716chatsecond"
        )
        self.assertEqual(f["chat"]["aggregateNeedle"], "oldaggregateneedle")
        log = self.owned_path(f["chat"]["path"])
        self.assertEqual(
            log.relative_to(self.profile / "logs").as_posix(), f["chat"]["relativePath"]
        )
        self.assertEqual(
            "chat:" + json.dumps(list(log.parts[-4:]), separators=(",", ":")), f["chat"]["id"]
        )
        self.assertTrue(f["sourceHashes"], "The native/log/recovery inputs have real hashes")
        backup = Path(f["backupManifest"]).resolve()
        self.assertTrue(backup.is_relative_to(self.profile.parent))
        self.assertFalse(backup.is_relative_to(self.profile))
        journal = Path(f["journalPath"]).resolve()
        self.assertEqual(journal, backup.parent.parent / "journal.json")
        self.assertEqual(backup.parent.parent.parent, self.profile.parent)
        self.assertTrue(journal.is_relative_to(self.profile.parent))
        self.assertFalse(journal.is_relative_to(self.profile))
        self.assertFalse(journal.is_relative_to(backup.parent))
        self.assertTrue(journal.is_file())
        self.assertTrue(Path(f["backedUp"]).resolve().is_relative_to(backup.parent))
        for row in f["sourceHashes"]:
            path = Path(row["path"]).resolve()
            self.assertTrue(
                path.is_relative_to(self.profile) or path.is_relative_to(backup.parent)
            )
            self.assertEqual(len(row["sha256"]), 64)

    def assert_receipt_keys(self):
        """Use actual source-scoped import receipts, never duplicate Message-ID."""
        journal = json.loads(Path(self.fixture["journalPath"]).read_text(encoding="utf-8"))
        self.assertEqual(Path(journal["profilePath"]).resolve(), self.profile)
        imported = set()
        for source in journal["sources"]:
            self.assertEqual(source["databaseSourceId"], self.fixture["sourceId"])
            keys = dict(source["receipt"]["keys"])
            self.assertEqual(set(keys), {1, 3})
            for key in keys.values():
                imported.add(str(key))
                expected = next(row for row in self.fixture["mail"] if row["id"] == str(key))
                self.assertEqual(expected["folderId"], source["destinationFolderId"])
        self.assertEqual(
            imported,
            {
                r["id"]
                for r in self.fixture["mail"]
                if r["kind"] not in ("mime-copy", "metadata-only")
            },
        )
        self.assertEqual(len(imported), 4)

    def assert_source_hashes(self):
        for row in self.fixture["sourceHashes"]:
            self.assertEqual(self.digest(Path(row["path"])), row["sha256"], row["path"])

    def assert_identity(self):
        actual = self.marionette.execute_script(
            """
            const { mailPolicyRevision } = ChromeUtils.importESModule('resource:///modules/panorama/MailSearchSource.sys.mjs');
            const selected = Services.dirsvc.get('ProfD', Ci.nsIFile);
            selected.normalize();
            if (selected.path !== arguments[1]) {
                throw new Error('The original retained profile was not selected');
            }
            const core = Cc['@mozilla.org/mailnews/database-core;1']
                .getService(Ci.nsIDatabaseCore);
            if (core.sourceId !== arguments[2]) {
                throw new Error('The retained native incarnation changed');
            }
            return {profile: Services.dirsvc.get('ProfD', Ci.nsIFile).path,
                    pid: Services.appinfo.processID, sourceId: core.sourceId,
                    native: Services.prefs.getBoolPref('mail.panorama.enabled'),
                    indexing: Services.prefs.getBoolPref('mailnews.database.global.indexer.enabled'),
                    members: arguments[0].map(({id, folderId}) => {
                        const state = core.messageDB.getSearchState(Number(id));
                        if (!state || state.folderId !== folderId ||
                            !Number.isInteger(state.folderFlags) ||
                            state.folderFlags < 0 || state.folderFlags > 0xffffffff ||
                            !(state.folderFlags & Ci.nsMsgFolderFlags.Mail) ||
                            (state.folderFlags & Ci.nsMsgFolderFlags.Virtual)) {
                            throw new Error('Trial native folder membership changed: ' + id);
                        }
                        return {id, folderId: state.folderId, folderFlags: state.folderFlags,
                            generation: state.generation,
                            contentRevision: state.contentRevision,
                            rawPolicyRevision: state.policyRevision,
                            policyRevision: mailPolicyRevision(state.policyRevision)};
                    })};
        """,
            script_args=[self.fixture["mail"], str(self.profile), self.fixture["sourceId"]],
        )
        self.assertEqual(Path(actual["profile"]).resolve(), self.profile)
        self.assertEqual(actual["pid"], self.marionette.process_id)
        self.assertGreater(actual["pid"], 0)
        self.assertEqual(actual["sourceId"], self.fixture["sourceId"])
        self.assertIs(actual["native"], True)
        self.assertIs(actual["indexing"], True)
        for member in actual["members"]:
            expected = next(row for row in self.fixture["mail"] if row["id"] == member["id"])
            self.assertEqual(member["folderId"], expected["folderId"])
            self.assertIs(type(member["folderFlags"]), int)
            raw_policy = member["rawPolicyRevision"]
            policy = member["policyRevision"]
            self.assertIs(type(raw_policy), str)
            self.assertEqual(raw_policy, self.fixture["recoveryPolicyRevision"])
            self.assertIs(type(policy), int)
            self.assertGreaterEqual(policy, 0)
            self.assertLessEqual(policy, 2**53 - 1)
            self.assertEqual(str(policy), raw_policy)
        return actual

    def snapshot(self, key):
        """Read closed sidecar rows; mode=ro cannot create a withheld database."""
        path = self.owned_path(self.fixture[key])
        self.assertTrue(path.is_file(), "The recorded checkpoint sidecar must still exist")
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as connection:
            connection.row_factory = sqlite3.Row
            return {
                table: [
                    dict(row)
                    for row in connection.execute(
                        "SELECT * FROM "
                        + table
                        + (" ORDER BY documentId" if table != "work_state" else "")
                    )
                ]
                for table in ("work_state", "document_versions", "documents", "index_jobs")
            }

    def record(self, name, value):
        """Keep raw progress and durable state even when a later oracle fails."""
        with (self.work / (name + ".json")).open("x", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=True, indent=2)

    def operation(self, phase):
        """Run actual owned services and propagate original errors after close."""
        result = self.marionette.execute_async_script(
            """
            const [f, phase] = arguments;
            const done = arguments[arguments.length - 1];
            (async () => {
                const { FileUtils } = ChromeUtils.importESModule('resource://gre/modules/FileUtils.sys.mjs');
                const { MailSearchService } = ChromeUtils.importESModule('resource:///modules/panorama/MailSearchService.sys.mjs');
                const { ChatSearchProvider } = ChromeUtils.importESModule('resource:///modules/panorama/ChatSearchProvider.sys.mjs');
                const core = Cc['@mozilla.org/mailnews/database-core;1'].getService(Ci.nsIDatabaseCore);
                if (core.sourceId !== f.sourceId) {
                    throw new Error('Trial native incarnation changed');
                }
                let mail, chat, value, failure;
                try {
                    mail = await MailSearchService.open(new FileUtils.File(f.mailSidecar), core.sourceId, core.messageDB);
                    chat = await ChatSearchProvider.open(new FileUtils.File(f.chatSidecar));
                    if (phase === 'update') {
                        // No query/rebuild/default factory/start while checkpointing.
                        value = await mail.update({limit: 2});
                    } else if (phase === 'final') {
                        await mail.rebuild();
                        let progress;
                        for (let batch = 0; batch < 200; batch++) {
                            progress = await mail.update({limit: 2});
                            if (!progress.rebuilding && !progress.pending &&
                                progress.acceptedThrough === progress.sourceWatermark) {
                                break;
                            }
                        }
                        if (progress.rebuilding || progress.pending ||
                            progress.acceptedThrough !== progress.sourceWatermark) {
                            throw new Error('Final rebuild exceeded fixed trial bound');
                        }
                        await chat.rebuild();
                        const rows = [];
                        for (const expected of f.mail) {
                            const state = mail.resolveDocument(expected.id);
                            const header = core.messageDB.getMessage(Number(expected.id));
                            rows.push({id: expected.id, text: await mail.getText(expected.id),
                                messageId: header.messageId, folderURI: header.folder.URI,
                                state: state && {eligible: state.eligible, generation: state.generation,
                                    contentRevision: state.contentRevision, policyRevision: state.policyRevision,
                                    folderId: state.location.folderId,
                                    originalContentAvailable: state.originalContentAvailable}});
                        }
                        const mailQueries = {};
                        for (const term of ['recovered', 's716availablebody', 's716copymetadata',
                            's716metadataonly', 'quarantineneedle', 'oldaggregateneedle', 'ghost-id', 'deleted-id']) {
                            const page = await mail.search(term, {limit: 100});
                            if (page.cursor) {
                                throw new Error('Unexpected mail trial page beyond fixed cohort');
                            }
                            mailQueries[term] = page.items;
                        }
                        const chatQueries = {};
                        for (const term of [...f.chat.bodyNeedles, f.chat.aggregateNeedle, 'quarantineneedle']) {
                            const page = await chat.search(term, {limit: 100});
                            if (page.cursor) {
                                throw new Error('Unexpected chat trial page beyond fixed cohort');
                            }
                            chatQueries[term] = page.items;
                        }
                        value = {progress, mail: rows, mailQueries, chatQueries,
                            mailRecovery: await mail.getRecoveryRecords(),
                            chatText: await chat.getText(f.chat.id),
                            chatRecovery: await chat.getRecoveryRecords(f.chat.id)};
                    } else {
                        throw new Error('Unknown trial phase');
                    }
                } catch (error) {
                    failure = error;
                }
                const closed = await Promise.allSettled([mail?.close(), chat?.close()]);
                const failures = closed.filter(row => row.status === 'rejected').map(row => row.reason);
                if (failure) {
                    failures.unshift(failure);
                }
                if (failures.length) {
                    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Trial operation/close failed');
                }
                return value;
            })().then(value => done({value}), error => done({error: {
                name: error.name, message: error.message, result: error.result,
                stack: error.stack, errors: error.errors?.map(item => String(item))
            }}));
        """,
            script_args=[self.fixture, phase],
            script_timeout=120000,
        )
        self.assertNotIn("error", result, json.dumps(result, ensure_ascii=True))
        return result["value"]

    def stop(self):
        """Require normal process termination, not a service-only reopen."""
        runner = self.marionette.instance.runner
        pid = self.marionette.process_id
        self.marionette.execute_script("Services.prefs.savePrefFile(null);")
        shutdown = self.marionette.quit(in_app=True, clean=False)
        self.assertIs(shutdown["forced"], False)
        self.assertEqual(shutdown["cause"], "shutdown")
        self.assertFalse(runner.is_running(), "The old real process ended")
        self.assertEqual(runner.returncode, 0)
        self.assertFalse(self.marionette.session)
        return {"pid": pid, "shutdown": shutdown, "exit": runner.returncode}

    def start(self):
        self.marionette.start_session(capabilities=self.capabilities)
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        return self.assert_identity()

    def assert_progress(self, progress, snapshot):
        (work,) = snapshot["work_state"]
        self.assertEqual(work["sourceId"], self.fixture["sourceId"])
        self.assertEqual(progress["sourceId"], work["sourceId"])
        self.assertEqual(progress["acceptedThrough"], work["checkpoint"])
        self.assertEqual(
            progress["pending"], sum(j["status"] == "pending" for j in snapshot["index_jobs"])
        )
        self.assertEqual(
            progress["unavailable"],
            sum(j["status"] == "unavailable" for j in snapshot["index_jobs"]),
        )
        self.assertLessEqual(progress["acceptedThrough"], progress["sourceWatermark"])

    def assert_settled(self, progress, snapshot):
        self.assert_progress(progress, snapshot)
        self.assertEqual(progress["acceptedThrough"], progress["sourceWatermark"])
        self.assertFalse(progress["rebuilding"])
        self.assertFalse(progress["moreWork"])
        self.assertEqual(progress["pending"], 0)
        self.assertEqual(progress["unavailable"], 3)
        self.assertIsNone(snapshot["work_state"][0]["rescanSequence"])
        self.assertEqual({row["documentId"] for row in snapshot["documents"]}, self.mail_ids)
        self.assertEqual(
            {row["documentId"] for row in snapshot["document_versions"]}, self.mail_ids
        )
        self.assertEqual({row["documentId"] for row in snapshot["index_jobs"]}, self.unavailable)
        self.assertTrue(all(row["status"] == "unavailable" for row in snapshot["index_jobs"]))
        for row in snapshot["documents"]:
            self.assertEqual(bool(row["bodyIndexed"]), row["documentId"] not in self.unavailable)

    def assert_final_corpus(self, result):
        f = self.fixture
        self.assertEqual(len(result["mail"]), len(f["mail"]))
        for expected, actual in zip(f["mail"], result["mail"]):
            self.assertEqual(actual["id"], expected["id"])
            self.assertEqual(actual["messageId"], expected["messageId"])
            self.assertEqual(actual["folderURI"], expected["folderURI"])
            state, text = actual["state"], actual["text"]
            self.assertIsNotNone(state)
            self.assertIs(state["eligible"], True)
            self.assertEqual(state["folderId"], expected["folderId"])
            self.assertIsNotNone(text, "Current native metadata must remain readable")
            for key in ("generation", "contentRevision", "policyRevision"):
                self.assertEqual(text[key], state[key])
            self.assertEqual(text["id"], expected["id"])
            self.assertIs(text["bodyIndexed"], expected["bodyReady"])
            if not expected["bodyReady"]:
                self.assertEqual(text["body"], "")
            if expected["bodyNeedle"]:
                self.assertIn(expected["bodyNeedle"], text["body"])
            if expected["metadataNeedle"]:
                self.assertIn(expected["metadataNeedle"], text["subject"])
            if expected["kind"] != "mime-copy":
                self.assertIs(state["originalContentAvailable"], False)
        by_id = {row["id"]: row["text"] for row in result["mail"]}
        self.assertEqual(by_id[f["recovered"]["id"]]["body"], f["recovered"]["body"])
        self.assertEqual(by_id[f["recovered"]["emptyId"]]["body"], "")
        for term, expected_ids in {
            "recovered": {f["recovered"]["id"]},
            "s716availablebody": {r["id"] for r in f["mail"] if r["kind"] == "mime-copy"},
            "s716copymetadata": {r["id"] for r in f["mail"] if r["kind"] == "mime-copy"},
            "s716metadataonly": {r["id"] for r in f["mail"] if r["kind"] == "metadata-only"},
            "quarantineneedle": set(),
            "oldaggregateneedle": set(),
            "ghost-id": set(),
            "deleted-id": set(),
        }.items():
            hits = result["mailQueries"][term]
            self.assertEqual(len(hits), len(expected_ids), term)
            self.assertEqual({hit["id"] for hit in hits}, expected_ids, term)
            for hit in hits:
                for key in ("generation", "contentRevision", "policyRevision", "textRevision"):
                    self.assertEqual(hit[key], by_id[hit["id"]][key])
        records = result["mailRecovery"]
        self.assertEqual(len(records), 6)
        self.assertEqual(len({r["recordId"] for r in records}), 6)
        self.assertEqual(
            sorted(r["payload"]["reason"] for r in records if r["documentId"] is None),
            ["deleted", "ghost"],
        )
        recovered = next(r for r in records if r["documentId"] == f["recovered"]["id"])
        self.assertEqual(recovered["payload"]["message"]["text"]["body"], f["recovered"]["body"])
        self.assertEqual(recovered["sourceRevision"], self.digest(Path(f["backedUp"])))
        self.assertEqual(
            recovered["payload"]["provenance"]["importReceipt"]["databaseSourceId"], f["sourceId"]
        )
        quarantined = next(
            r for r in records if r["documentId"] == f["recovered"]["quarantinedId"]
        )
        self.assertEqual(quarantined["payload"]["disposition"], "quarantined")
        chat = result["chatText"]
        self.assertIsNotNone(chat)
        self.assertEqual(chat["id"], f["chat"]["id"])
        self.assertEqual(chat["body"], f["chat"]["expectedBody"])
        self.assertEqual(chat["contentRevision"], self.digest(Path(f["chat"]["path"])))
        self.assertIs(chat["bodyIndexed"], True)
        for term in f["chat"]["bodyNeedles"]:
            hits = result["chatQueries"][term]
            self.assertEqual(len(hits), 1)
            self.assertEqual(hits[0]["id"], f["chat"]["id"])
            for key in ("generation", "contentRevision", "policyRevision", "textRevision"):
                self.assertEqual(hits[0][key], chat[key])
        for term in (f["chat"]["aggregateNeedle"], "quarantineneedle"):
            self.assertEqual(result["chatQueries"][term], [])
        self.assertEqual(len(result["chatRecovery"]), 1)
        (aggregate,) = result["chatRecovery"]
        self.assertEqual(aggregate["payload"]["disposition"], "quarantined")
        self.assertIn("oldaggregateneedle", aggregate["payload"]["text"])

    def test_trial_rebuild_survives_real_application_restart(self):
        self.maxDiff = None
        initial = self.snapshot("mailSidecar")
        self.record("marionette-initial", initial)
        history = []
        for batch in range(200):
            progress = self.operation("update")
            mail = self.snapshot("mailSidecar")
            self.assert_progress(progress, mail)
            history.append(progress)
            pending_ids = {r["documentId"] for r in mail["index_jobs"]}
            candidate_identity = self.assert_identity()
            candidate_native = {row["id"]: row for row in candidate_identity["members"]}
            candidate_versions = {row["documentId"]: row for row in mail["document_versions"]}
            delivery_through = max(
                progress["acceptedThrough"], mail["work_state"][0]["rescanSequence"] or 0
            )
            # Native generation is max(latest physical event, policy marker).
            # A historical event can already carry that current generation.
            # Its body is not delivery-current until the accepted token covers it.
            completed = {}
            for document in mail["documents"]:
                key = document["documentId"]
                version = candidate_versions.get(key)
                state = candidate_native.get(key)
                if (
                    document["bodyIndexed"]
                    and key not in pending_ids
                    and version is not None
                    and state is not None
                    and version["kind"] == "index"
                    and document["changeSequence"] == version["sequence"]
                    and state["generation"] <= version["sequence"] <= delivery_through
                    and all(
                        document[field] == version[field] == state[field]
                        for field in ("generation", "policyRevision")
                    )
                    and document["contentRevision"] == state["contentRevision"]
                ):
                    completed[key] = document
            unaccepted_ids = {
                key
                for key, state in candidate_native.items()
                if key not in candidate_versions
                or candidate_versions[key]["sequence"] < state["generation"]
            }
            pending_work_ids = {
                row["documentId"] for row in mail["index_jobs"] if row["status"] == "pending"
            }
            unfinished_ids = (unaccepted_ids | pending_work_ids) & self.mail_ids
            selection = {
                "batch": batch,
                "identity": candidate_identity,
                "mail": mail,
                "progress": progress,
                "deliveryThrough": delivery_through,
                "completedIds": sorted(completed),
                "unacceptedIds": sorted(unaccepted_ids),
                "pendingWorkIds": sorted(pending_work_ids),
                "unfinishedIds": sorted(unfinished_ids),
            }
            remaining = (
                progress["pending"]
                or progress["acceptedThrough"] < progress["sourceWatermark"]
                or mail["work_state"][0]["rescanSequence"] is not None
            )
            if completed and remaining and unfinished_ids:
                break
        else:
            self.record("marionette-checkpoint-selection-unsettled", selection)
            self.record("marionette-checkpoint-unsettled", history)
            self.fail("The fixed corpus never produced a completed-and-unfinished checkpoint")
        self.record("marionette-checkpoint-selection", selection)
        self.assertTrue(completed)
        self.assertTrue(unfinished_ids - set(completed))
        self.assertTrue(set(completed).issubset(self.mail_ids))
        chat = self.snapshot("chatSidecar")
        before = self.assert_identity()
        self.assertEqual(before["members"], candidate_identity["members"])
        native = {row["id"]: row for row in before["members"]}
        versions = {row["documentId"]: row for row in mail["document_versions"]}
        self.assertEqual(set(native), self.mail_ids)
        for key, document in completed.items():
            self.assertEqual(versions[key]["kind"], "index")
            self.assertEqual(document["changeSequence"], versions[key]["sequence"])
            self.assertGreaterEqual(versions[key]["sequence"], native[key]["generation"])
            self.assertLessEqual(versions[key]["sequence"], delivery_through)
            for field in ("generation", "policyRevision"):
                self.assertEqual(document[field], versions[key][field])
                self.assertEqual(document[field], native[key][field])
            self.assertEqual(document["contentRevision"], native[key]["contentRevision"])
        checkpoint = {"identity": before, "mail": mail, "chat": chat, "progress": history}
        self.record("marionette-checkpoint", checkpoint)
        shutdown = self.stop()
        self.assertEqual(self.snapshot("mailSidecar"), mail)
        self.assertEqual(self.snapshot("chatSidecar"), chat)
        # The declared negative withholds ONLY the closed owned mail sidecar here.
        after = self.start()
        self.assertNotEqual(before["pid"], after["pid"])
        self.assertEqual(
            before["members"],
            after["members"],
            "Native versions survive the same-profile process restart",
        )
        self.assertEqual(
            self.snapshot("mailSidecar"),
            mail,
            "Resume must retain exact checkpoint/versions/jobs before any advance",
        )
        self.assertEqual(self.snapshot("chatSidecar"), chat)
        self.assert_source_hashes()
        self.assertEqual(self.digest(Path(self.fixture["journalPath"])), self.journal_hash)
        self.assert_receipt_keys()
        self.record(
            "marionette-restarted",
            {"before": before, "after": after, "shutdown": shutdown, "mail": mail, "chat": chat},
        )
        history = []
        versions = {r["documentId"]: r for r in mail["document_versions"]}
        for batch in range(200):
            progress = self.operation("update")
            current = self.snapshot("mailSidecar")
            self.assert_progress(progress, current)
            history.append(progress)
            current_rows = {r["documentId"]: r for r in current["documents"]}
            current_versions = {r["documentId"]: r for r in current["document_versions"]}
            for key, document in completed.items():
                if current_rows.get(key) != document or current_versions.get(key) != versions[key]:
                    self.record(
                        f"marionette-resume-mismatch-{batch:03d}-{key}",
                        {
                            "id": key,
                            "checkpoint": checkpoint,
                            "restartedIdentity": after,
                            "progress": history,
                            "mail": current,
                        },
                    )
                self.assertEqual(
                    current_rows[key],
                    document,
                    "A completed physical text revision must not be replayed",
                )
                self.assertEqual(current_versions[key], versions[key])
            if (
                not progress["pending"]
                and not progress["rebuilding"]
                and progress["acceptedThrough"] == progress["sourceWatermark"]
            ):
                break
        else:
            self.record("marionette-resume-unsettled", history)
            self.fail("Resumed fixed corpus did not settle within 200 bounded batches")
        self.assert_settled(progress, current)
        self.record("marionette-settled", {"progress": history, "mail": current})
        result = self.operation("final")
        self.record("marionette-final-raw", result)
        self.assert_settled(result["progress"], self.snapshot("mailSidecar"))
        self.assertEqual(
            {r["documentId"] for r in self.snapshot("chatSidecar")["documents"]},
            {self.fixture["chat"]["id"]},
        )
        self.assert_final_corpus(result)
        self.assert_source_hashes()
        self.assert_receipt_keys()
        self.run_s717_policy_rebuild()

    def s717_operation(self, phase):
        """Use actual native services/readers and preserve operation and close errors."""
        result = self.marionette.execute_async_script(
            r"""
            const [f, phase, retained] = arguments;
            const done = arguments[arguments.length - 1];
            (async () => {
                const root = Services.wm.getMostRecentWindow('mail:3pane');
                const handler = Services.io.getProtocolHandler('resource').QueryInterface(Ci.nsIResProtocolHandler);
                const currentModules = () => handler.hasSubstitution('testing-common')
                    ? handler.getSubstitution('testing-common') : null;
                const sameURI = (left, right) => left === null ? right === null : right !== null && left.equals(right);
                /**
                 * Restore this process's prior testing-common substitution.
                 * Refuse an unrelated writer's replacement and retain custody on failure.
                 * @throws {Error} If the owner, process or current substitution changed.
                 */
                function restoreModules() {
                    const custody = root.__s717TestModules;
                    if (!custody) { return; }
                    if (custody.owner !== f.mailSidecar || custody.pid !== Services.appinfo.processID) {
                        throw new Error('S717 test-module custody belongs to another owner/process');
                    }
                    const current = currentModules();
                    if (sameURI(current, custody.installed)) {
                        if (!sameURI(custody.installed, custody.previous)) {
                            handler.setSubstitution('testing-common', custody.previous);
                        }
                    } else if (!sameURI(current, custody.previous)) {
                        throw new Error('S717 cannot restore a foreign test-module substitution');
                    }
                    if (!sameURI(currentModules(), custody.previous)) {
                        throw new Error('S717 previous test-module substitution was not restored');
                    }
                    delete root.__s717TestModules;
                }
                /**
                 * Register the ordinary installed modules used by this application test.
                 * Follow send_later.js's bounded GreD/_tests|tests ancestor lookup.
                 * @throws {Error} For missing installed files or changed module custody.
                 */
                function registerModules() {
                    const custody = root.__s717TestModules;
                    if (custody) {
                        if (custody.owner !== f.mailSidecar || custody.pid !== Services.appinfo.processID ||
                            !sameURI(currentModules(), custody.installed)) {
                            throw new Error('S717 installed test-module custody changed');
                        }
                        return;
                    }
                    let rootDir = Services.dirsvc.get('GreD', Ci.nsIFile);
                    for (let depth = 0; rootDir && depth < 5; depth++, rootDir = rootDir.parent) {
                        for (const layout of ['_tests', 'tests']) {
                            const modules = rootDir.clone();
                            modules.append(layout);
                            modules.append('modules');
                            const hasModule = name => {
                                const file = modules.clone();
                                file.append(name);
                                return file.exists() && file.isFile();
                            };
                            if (!['TestUtils.sys.mjs', 'TestProtocol.sys.mjs'].every(hasModule)) { continue; }
                            // These are the pinned modules' production dependencies, not copied test logic.
                            for (const uri of ['resource://gre/modules/Timer.sys.mjs',
                                'resource:///modules/jsProtoHelper.sys.mjs', 'resource:///modules/imCore.sys.mjs',
                                'resource:///modules/imXPCOMUtils.sys.mjs']) {
                                ChromeUtils.importESModule(uri);
                            }
                            const previous = currentModules();
                            const installed = Services.io.newFileURI(modules);
                            root.__s717TestModules = {owner: f.mailSidecar, pid: Services.appinfo.processID, previous, installed};
                            if (!sameURI(previous, installed)) {
                                handler.setSubstitution('testing-common', installed);
                            }
                            if (!sameURI(currentModules(), installed)) {
                                throw new Error('S717 installed test-module substitution was not selected');
                            }
                            return;
                        }
                    }
                    throw new Error('S717 ordinary installed modules/TestUtils.sys.mjs and TestProtocol.sys.mjs are missing');
                }
                let intakeFailed = false, intakeError;
                try {
                    if (phase === 'cleanup' && !root.__s717PolicyTrial && !retained.mail) {
                        // Intake failed before any S717-owned MIME or logger mutation.
                        // The outer finally still restores any partially installed mapping.
                        return {ownedStateAbsent: true};
                    }
                    registerModules();
                    const { FileUtils } = ChromeUtils.importESModule('resource://gre/modules/FileUtils.sys.mjs');
                    const { TestUtils } = ChromeUtils.importESModule('resource://testing-common/TestUtils.sys.mjs');
                    const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
                    const { IMServices } = ChromeUtils.importESModule('resource:///modules/IMServices.sys.mjs');
                    const { MailConsts } = ChromeUtils.importESModule('resource:///modules/MailConsts.sys.mjs');
                    const { MailSearchService } = ChromeUtils.importESModule('resource:///modules/panorama/MailSearchService.sys.mjs');
                    const { mailPolicyRevision } = ChromeUtils.importESModule('resource:///modules/panorama/MailSearchSource.sys.mjs');
                    const { ChatSearchProvider, chatSearchDocumentId } = ChromeUtils.importESModule('resource:///modules/panorama/ChatSearchProvider.sys.mjs');
                    const { getChatSearchService, closeChatSearch } = ChromeUtils.importESModule('resource:///modules/panorama/ChatSearchService.sys.mjs');
                    const logger = ChromeUtils.importESModule('resource:///modules/logger.sys.mjs');
                    const protocol = ChromeUtils.importESModule('resource://testing-common/TestProtocol.sys.mjs');
                    const tabmail = root.document.getElementById('tabmail');
                    const core = Cc['@mozilla.org/mailnews/database-core;1'].getService(Ci.nsIDatabaseCore);
                    const c = f.s717;
                    const require = (condition, message) => {
                        if (!condition) { throw new Error('S717: ' + message); }
                    };
                    require(c?.version === 1 && c.mail && c.chat && c.recovered, 'admitted descriptor');
                    require(core.sourceId === f.sourceId, 'original native incarnation');
                    const selectedProfile = Services.dirsvc.get('ProfD', Ci.nsIFile);
                    selectedProfile.normalize();
                    require(selectedProfile.path === retained.profile, 'same actual ProfD');
                    require(Services.prefs.getBoolPref('mail.panorama.enabled') &&
                        Services.prefs.getBoolPref('mailnews.database.global.indexer.enabled'), 'ordinary initialized native process');
                    let s = root.__s717PolicyTrial;
                    if (!s) {
                        require(['inputs', 'resumed', 'cleanup'].includes(phase), 'owned state must survive within its process');
                        s = {owner: f.mailSidecar, data: retained, tabs: [...tabmail.tabInfo],
                             conversations: [], registered: false, prefs: []};
                        root.__s717PolicyTrial = s;
                    }
                    require(s.owner === f.mailSidecar, 'never borrow another owner');
                    const d = s.data;
                    let mail, provider, value, failure;
                    const failures = [];
                    /**
                     * Read current native tokens without the old S716 policy oracle.
                     * @returns {object} Actual profile, PID, source and typed physical members.
                     */
                    function identity() {
                        const ids = [...f.mail.map(row => row.id), ...Object.values(d.mail || {}).map(row => row.id)];
                        return {profile: PathUtils.profileDir, sourceId: core.sourceId, pid: Services.appinfo.processID,
                            members: ids.map(id => {
                                const state = core.messageDB.getSearchState(Number(id));
                                return state ? {id, folderId: state.folderId, folderFlags: state.folderFlags,
                                    generation: state.generation, contentRevision: state.contentRevision,
                                    rawPolicyRevision: state.policyRevision, policyRevision: mailPolicyRevision(state.policyRevision)}
                                    : {id, deleted: true};
                            })};
                    }
                    /**
                     * Read persisted scoped exclusions without authorizing unknown history.
                     * @returns {Promise<object>} Nonempty receipts for the owned erased versions.
                     */
                    async function privacy() {
                        const state = await logger.getChatPrivacyState();
                        require(state.historyKnown === false, 'unknown historical logging remains unknown');
                        const parts = JSON.stringify(JSON.parse(d.chat.id.slice(5)));
                        const receipts = [...state.pending, ...state.completed].filter(receipt =>
                            receipt.targets.some(target => JSON.stringify(target.relativePath) === parts));
                        for (const name of ['deleted', 'noLog', 'redacted']) {
                            const matches = receipts.filter(receipt => receipt.remoteId === c.chat[name].remoteId);
                            require(matches.length > 0 && matches.every(receipt => receipt.targets.some(target =>
                                JSON.stringify(target.relativePath) === parts && target.records.length > 0)),
                                'durable scoped privacy receipt for ' + name);
                        }
                        return {historyKnown: state.historyKnown, receipts};
                    }
                    /**
                     * Search through the retained toolbar and actual native result view.
                     * @param {string} text - Literal query from the fixed case descriptor.
                     * @returns {Promise<object>} Real tab, frame and native FacetContext.
                     */
                    async function query(text) {
                        const input = root.document.querySelector('#unifiedToolbarContent global-search-bar');
                        require(input, 'retained global search bar');
                        input.popup.selectedIndex = -1;
                        input.dispatchEvent(new root.CustomEvent('search', {detail: text}));
                        const tab = tabmail.currentTabInfo;
                        require(tab.mode.name === 'glodaFacet', 'real native result tab');
                        await TestUtils.waitForCondition(() => tab.searchPromise, 'native query started');
                        require(await tab.searchPromise, 'native query completed');
                        const win = tab.browser.contentWindow;
                        require(win.FacetContext.chatSearchResultSet, 'current chat result set');
                        return {tab, win, context: win.FacetContext};
                    }
                    /**
                     * Drain every owned writer, tab and preference after any earlier failure.
                     * @returns {Promise<void>} All errors are retained in one AggregateError.
                     */
                    async function closeLive() {
                        const errors = [];
                        for (const conv of s.conversations) {
                            try { conv.close(); } catch (error) { errors.push(error); }
                            try { logger.closeLogWriter(conv); } catch (error) { errors.push(error); }
                        }
                        s.conversations = [];
                        for (const path of [d.chat?.path, d.chat?.otherPath].filter(Boolean)) {
                            try { await logger.gFilePromises.get(path); } catch (error) { errors.push(error); }
                        }
                        try { await closeChatSearch(); } catch (error) { errors.push(error); }
                        if (s.account) {
                            try {
                                if (s.account.connected || s.account.connecting) { s.account.disconnect(); }
                                IMServices.accounts.deleteAccount(s.account.id);
                                s.account = null;
                            } catch (error) { errors.push(error); }
                        }
                        if (s.registered) {
                            try { protocol.unregisterTestProtocol(); s.registered = false; }
                            catch (error) { errors.push(error); }
                        }
                        for (const tab of [...tabmail.tabInfo]) {
                            if (!s.tabs.includes(tab)) {
                                try { tabmail.closeTab(tab); } catch (error) { errors.push(error); }
                            }
                        }
                        for (const pref of s.prefs) {
                            try {
                                if (pref.hadValue) { Services.prefs.setIntPref(pref.name, pref.value); }
                                else { Services.prefs.clearUserPref(pref.name); }
                            } catch (error) { errors.push(error); }
                        }
                        s.prefs = [];
                        if (errors.length) { throw new AggregateError(errors, 'S717 owned live cleanup'); }
                    }
                    try {
                        if (phase === 'inputs' || phase === 'resumed') {
                            const name = 'mail.openMessageBehavior';
                            s.prefs.push({name, hadValue: Services.prefs.prefHasUserValue(name), value: Services.prefs.getIntPref(name)});
                            Services.prefs.setIntPref(name, MailConsts.OpenMessageBehavior.NEW_TAB);
                        }
                        if (phase === 'inputs') {
                            require(!d.mail && !d.chat, 'fresh inputs only after the S716 prefix');
                            d.mail = {};
                            d.factorySidecar = PathUtils.join(PathUtils.profileDir, 'panorama-chat-search.sqlite');
                            require(d.factorySidecar !== f.chatSidecar, 'factory and retained sidecar remain distinct');
                            const parent = MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
                            for (const [name, item] of Object.entries(c.mail)) {
                                const folders = item.folders || [item.folder];
                                for (const [i, folderName] of folders.entries()) {
                                    require(!parent.containsChildNamed(folderName), 'do not overwrite an existing target folder');
                                    const folder = parent.createLocalSubfolder(folderName).QueryInterface(Ci.nsIMsgLocalMailFolder);
                                    const raw = ['From: Trial Sender <sender@example.invalid>',
                                        'To: Trial Recipient <recipient@example.invalid>', 'Date: Tue, 01 Jan 2019 00:00:00 +0000',
                                        `Message-ID: <${item.messageId}>`, `Subject: ${item.oldSubject || item.subject}`,
                                        'Content-Type: text/plain; charset=utf-8', '', item.body, ''].join('\r\n');
                                    const header = folder.addMessage(Array.from(new TextEncoder().encode(raw), byte => String.fromCharCode(byte)).join(''));
                                    require(header && header.folder.id === folder.id && header.messageId === item.messageId, 'real physical MIME delivery');
                                    const key = name === 'open' ? (i === 0 ? 'selected' : 'other') : name;
                                    d.mail[key] = {id: String(header.messageKey), folderId: folder.id,
                                        folderURI: folder.URI, messageId: header.messageId};
                                }
                            }
                            require(d.mail.selected.id !== d.mail.other.id, 'equal Message-ID copies have distinct physical keys');
                            d.excludedFlags = core.folderDB.getFolderFlags(d.mail.excluded.folderId);
                            require(!(d.excludedFlags & Ci.nsMsgFolderFlags.Junk), 'fresh exclusion target starts eligible');
                            require(c.recovered.id === f.recovered.id && c.recovered.body === f.recovered.body, 'original recovered survivor');
                            IMServices.core.init();
                            if (!IMServices.core.getProtocols().some(item => item.id === 'prpl-mochitest')) {
                                protocol.registerTestProtocol(); s.registered = true;
                            }
                            require(!IMServices.accounts.getAccounts().some(account => account.name === c.chat.account), 'fresh protocol account');
                            s.account = IMServices.accounts.createAccount(c.chat.account, 'prpl-mochitest');
                            const updated = TestUtils.topicObserved('account-updated', subject => subject === s.account);
                            s.account.password = 'S717 owned logger fixture';
                            await updated;
                            s.account.connect();
                            const chat = await getChatSearchService();
                            const conv = s.account.prplAccount.wrappedJSObject.makeDM(c.chat.conversation);
                            s.conversations.push(conv);
                            for (const name of ['edit', 'deleted', 'noLog', 'redacted', 'keep']) {
                                const item = c.chat[name];
                                conv.writeMessage('NativeSpeaker', item.oldText || item.text, {incoming: true, remoteId: item.remoteId});
                            }
                            const other = s.account.prplAccount.wrappedJSObject.makeDM(c.chat.conversation + '-other');
                            s.conversations.push(other);
                            other.writeMessage('OtherSpeaker', c.chat.otherPhysical, {incoming: true, remoteId: c.chat.keep.remoteId});
                            await chat.flush();
                            const path = logger.getLogWriter(conv).currentPath;
                            const otherPath = logger.getLogWriter(other).currentPath;
                            d.chat = {path, id: chatSearchDocumentId(path), otherPath, otherId: chatSearchDocumentId(otherPath)};
                            require(d.chat.id !== d.chat.otherId, 'equal remote ID never groups physical logs');
                            s.oldView = await query(c.chat.edit.oldText);
                            d.oldItem = s.oldView.context.chatSearchResultSet.items.find(item => item.hit.id === d.chat.id);
                            require(d.oldItem?.document.body.includes(c.chat.edit.oldText), 'actual captured pre-edit result');
                            mail = await MailSearchService.open(new FileUtils.File(f.mailSidecar), core.sourceId, core.messageDB);
                            await mail.rebuild();
                            value = {inputs: d, identity: identity()};
                        } else if (phase === 'identity' || phase === 'resumed') {
                            value = {identity: identity()};
                            if (phase === 'resumed') { value.privacy = await privacy(); }
                        } else if (phase === 'update' || phase === 'cancel') {
                            mail = await MailSearchService.open(new FileUtils.File(f.mailSidecar), core.sourceId, core.messageDB);
                            if (phase === 'update') {
                                value = {progress: await mail.update({limit: 2}), identity: identity()};
                            } else {
                                const controller = new AbortController();
                                const reason = new Error('S717 pending mail cancellation');
                                let settled = false;
                                const pending = mail.update({limit: 2, signal: controller.signal});
                                const observed = pending.then(() => { settled = true; return null; }, error => { settled = true; return error; });
                                try {
                                    await Promise.resolve();
                                    require(!controller.signal.aborted && !settled, 'a real non-preaborted update remains pending');
                                    controller.abort(reason);
                                    require(await observed === reason, 'original pending cancellation reason');
                                    value = {cancelled: true, reason: reason.message, identity: identity()};
                                } finally {
                                    if (!controller.signal.aborted) { controller.abort(reason); }
                                    await observed;
                                }
                            }
                        } else if (phase === 'mutations') {
                            core.messageDB.getMessage(Number(d.mail.edit.id)).subject = c.mail.edit.newSubject;
                            core.messageDB.removeMessage(Number(d.mail.deleted.id));
                            // Dedicated negative removes ONLY this exclusion operation.
                            core.folderDB.updateFlags(d.mail.excluded.folderId, d.excludedFlags | Ci.nsMsgFolderFlags.Junk);
                            const conv = s.conversations[0];
                            conv.updateMessage('NativeSpeaker', c.chat.edit.newText, {incoming: true, remoteId: c.chat.edit.remoteId});
                            conv.updateMessage('NativeSpeaker', '', {incoming: true, remoteId: c.chat.deleted.remoteId, deleted: true});
                            conv.updateMessage('NativeSpeaker', '', {incoming: true, remoteId: c.chat.noLog.remoteId, noLog: true});
                            const redaction = conv.createMessage('NativeSpeaker', '', {incoming: true, remoteId: c.chat.redacted.remoteId, deleted: true});
                            conv.notifyObservers(redaction, 'update-text');
                            const chat = await getChatSearchService();
                            await chat.flush();
                            const tabs = tabmail.tabInfo.length;
                            require(await s.oldView.context.openChatSearchConversation(d.oldItem) === null, 'retired pre-edit result refuses delivery');
                            require(tabmail.tabInfo.length === tabs, 'stale opening adds no reader');
                            const text = await chat.getText(d.chat.id);
                            require(text?.body.includes(c.chat.edit.newText) && text.body.includes(c.chat.keep.text), 'current kept Unicode text');
                            for (const term of [c.chat.edit.oldText, c.chat.deleted.text, c.chat.noLog.text, c.chat.redacted.text]) {
                                require((await chat.search(term)).items.length === 0 && !text.body.includes(term), 'suppressed chat text: ' + term);
                            }
                            const cancelPath = PathUtils.join(retained.work, 's717-cancel.sqlite');
                            require(!await IOUtils.exists(cancelPath), 'do not overwrite an existing cancellation artifact');
                            provider = await ChatSearchProvider.open(new FileUtils.File(cancelPath));
                            const entered = Promise.withResolvers();
                            const gate = Promise.withResolvers();
                            const held = logger.queueFileOperation(d.chat.path, async () => { entered.resolve(); await gate.promise; });
                            const controller = new AbortController();
                            const reason = new Error('S717 queued log read cancellation');
                            let observed;
                            try {
                                await entered.promise;
                                const pending = provider.refreshLog(d.chat.path, {signal: controller.signal});
                                observed = pending.then(() => null, error => error);
                                await TestUtils.waitForCondition(() => logger.gFilePromises.get(d.chat.path) !== held,
                                    'real provider read queued behind owned source operation');
                                controller.abort(reason);
                                gate.resolve();
                                require(await observed === reason, 'queued source read preserves original reason');
                            } finally {
                                controller.abort(reason);
                                gate.resolve();
                                await held;
                                if (observed) { await observed; }
                            }
                            value = {identity: identity(), privacy: await privacy(), chatText: text,
                                junkFlag: Ci.nsMsgFolderFlags.Junk, staleRefused: true, queuedReadCancelled: true};
                        } else if (phase === 'close') {
                            await closeLive();
                            value = {identity: identity(), privacy: await privacy()};
                        } else if (phase === 'mail-final') {
                            mail = await MailSearchService.open(new FileUtils.File(f.mailSidecar), core.sourceId, core.messageDB);
                            const expected = new Map([
                                [c.mail.edit.oldSubject, []], [c.mail.edit.newSubject, [d.mail.edit.id]],
                                [c.mail.deleted.body, []], [c.mail.excluded.body, []],
                                [c.mail.open.body.split(' ')[0], [d.mail.selected.id, d.mail.other.id]],
                                ['recovered', [f.recovered.id]], ['quarantineneedle', []],
                                ['oldaggregateneedle', []], ['ghost-id', []], ['deleted-id', []],
                            ]);
                            const queries = {};
                            for (const [term, ids] of expected) {
                                const page = await mail.search(term, {limit: 100});
                                require(!page.cursor && JSON.stringify(page.items.map(hit => hit.id).sort()) === JSON.stringify([...ids].sort()),
                                    'exact physical query results: ' + term);
                                for (const hit of page.items) {
                                    const text = await mail.getText(hit.id);
                                    const state = core.messageDB.getSearchState(Number(hit.id));
                                    require(state && text, 'current native query text');
                                    for (const key of ['generation', 'contentRevision', 'policyRevision', 'textRevision']) {
                                        require(hit[key] === text[key], 'current mail hit/text ' + key);
                                    }
                                    require(text.generation === state.generation && text.contentRevision === state.contentRevision &&
                                        text.policyRevision === mailPolicyRevision(state.policyRevision), 'current native policy/content tokens');
                                }
                                queries[term] = page.items;
                            }
                            const recovered = await mail.getText(f.recovered.id);
                            require(recovered?.body === f.recovered.body, 'eligible recovery survives policy/restart/rebuild');
                            const records = await mail.getRecoveryRecords();
                            const retainedRecord = records.find(row => row.documentId === f.recovered.id);
                            require(records.length === 6 && retainedRecord.payload.message.text.body === f.recovered.body,
                                'recovery record/provenance retained');
                            require(retainedRecord.payload.provenance.importReceipt.databaseSourceId === f.sourceId,
                                'original recovery source mapping');
                            const tabs = tabmail.tabInfo.length;
                            for (const [id, status] of [[d.mail.deleted.id, 'deleted'], [d.mail.excluded.id, 'ineligible'], [f.recovered.id, 'unavailable']]) {
                                require((await mail.openResult(id, {tabmail})).status === status, 'negative mail open: ' + status);
                                require(tabmail.tabInfo.length === tabs, 'negative mail open adds no substitute reader');
                            }
                            const controller = new AbortController();
                            const reason = new Error('S717 cancelled mail opening');
                            controller.abort(reason);
                            let refusal;
                            try { await mail.openResult(d.mail.selected.id, {tabmail, signal: controller.signal}); }
                            catch (error) { refusal = error; }
                            require(refusal === reason && tabmail.tabInfo.length === tabs, 'cancelled open never dispatches another copy');
                            const opened = await mail.openResult(d.mail.selected.id, {tabmail});
                            require(opened.status === 'ready' && String(opened.header.messageKey) === d.mail.selected.id &&
                                opened.header.folder.URI === d.mail.selected.folderURI, 'real selected physical mail open');
                            const reader = tabmail.currentTabInfo;
                            require(reader.mode.name === 'mailMessageTab', 'normal mail reader tab');
                            await TestUtils.waitForCondition(() => reader.message && reader.browser?.contentDocument?.body?.textContent.includes(c.mail.open.body),
                                'selected physical MIME text loaded in actual reader');
                            require(String(reader.message.messageKey) === d.mail.selected.id && reader.message.folder.URI === d.mail.selected.folderURI,
                                'reader selected exact key/folder, not Message-ID peer');
                            value = {queries, recovered, records, selected: d.mail.selected,
                                reader: {id: String(reader.message.messageKey), folderURI: reader.message.folder.URI,
                                    body: reader.browser.contentDocument.body.textContent}, identity: identity()};
                        } else if (phase === 'chat-final') {
                            const chat = await getChatSearchService();
                            await chat.flush();
                            const document = await chat.getText(d.chat.id);
                            require(document?.body.includes(c.chat.edit.newText) && document.body.includes(c.chat.keep.text), 'current selected transcript');
                            require(!document.body.includes(c.chat.otherPhysical), 'equal logical ID never merges physical source');
                            for (const term of [c.chat.edit.oldText, c.chat.deleted.text, c.chat.noLog.text, c.chat.redacted.text]) {
                                require((await chat.search(term)).items.length === 0 && !document.body.includes(term), 'no privacy revival: ' + term);
                            }
                            const staleView = await query(c.chat.keep.text.split(' ')[0]);
                            const count = tabmail.tabInfo.length;
                            require(await staleView.context.openChatSearchConversation(d.oldItem) === null && tabmail.tabInfo.length === count,
                                'pre-edit tokens refused after real process restart');
                            const item = staleView.context.chatSearchResultSet.items.find(row => row.hit.id === d.chat.id);
                            require(item && item.hit.contentRevision === document.contentRevision && item.hit.textRevision === document.textRevision,
                                'rendered current hit revisions');
                            const entered = Promise.withResolvers();
                            const gate = Promise.withResolvers();
                            const held = logger.queueFileOperation(d.chat.path, async () => { entered.resolve(); await gate.promise; });
                            let observed, settled = false;
                            try {
                                await entered.promise;
                                const ownerSignal = staleView.tab.mailSearchController.signal;
                                const opening = staleView.context.openChatSearchConversation(item);
                                observed = opening.then(() => { settled = true; return null; }, error => { settled = true; return error; });
                                tabmail.closeTab(staleView.tab);
                                // A bounded semantic wait still reaches finally if abort delivery is broken.
                                await TestUtils.waitForCondition(() => settled, 'retired reader open settles while source I/O remains held');
                                const error = await observed;
                                require(ownerSignal.aborted && error === ownerSignal.reason && error?.name === 'AbortError',
                                    'closing real result view preserves its parent-owned abort reason');
                                require(tabmail.currentTabInfo.mode.name !== 'chat', 'retired view never dispatches reader');
                            } finally {
                                gate.resolve();
                                await held;
                                if (observed) { await observed; }
                            }
                            const view = await query(c.chat.keep.text.split(' ')[0]);
                            const current = view.context.chatSearchResultSet.items.find(row => row.hit.id === d.chat.id);
                            require(current && current.hit.id !== d.chat.otherId, 'fresh physical result after cancelled delivery');
                            const row = [...view.win.document.querySelectorAll('.native-chat-result')].find(node => node.dataset.id === d.chat.id);
                            require(row?.querySelector('button'), 'rendered ordinary result button');
                            const browser = root.document.getElementById('conv-log-browser');
                            let loaded = false, displayed = false;
                            const observer = subject => { if (subject === browser) { loaded = true; } };
                            const onDisplayed = () => { displayed = true; };
                            Services.obs.addObserver(observer, 'conversation-loaded');
                            browser.addEventListener('MessagesDisplayed', onDisplayed);
                            try {
                                row.querySelector('button').click();
                                await TestUtils.waitForCondition(() => loaded && displayed && view.tab.chatSearchOpenPromise,
                                    'real conversation-loaded and MessagesDisplayed');
                                await view.tab.chatSearchOpenPromise;
                                require(tabmail.currentTabInfo.mode.name === 'chat', 'actual chat reader');
                                const resolved = root.document.getElementById('searchResultConv').nativeChatLog.resolved;
                                require(resolved.id === d.chat.id && resolved.contentRevision === current.hit.contentRevision &&
                                    resolved.textRevision === current.hit.textRevision, 'selected physical log and current tokens');
                                const messages = browser._conv.getMessages();
                                const body = messages.map(message => message.message).join('\n');
                                require(messages.some(message => message.who === 'NativeSpeaker' && message.message.includes(c.chat.keep.text)),
                                    'physical reader retains the current speaker and text');
                                const rendered = browser.contentDocument.body.textContent;
                                require(rendered.includes('NativeSpeaker') && rendered.includes(c.chat.keep.text.split(' ')[0]),
                                    'actual rendered speaker and selected body');
                                require(body.includes(c.chat.edit.newText) && body.includes(c.chat.keep.text) && !body.includes(c.chat.otherPhysical),
                                    'actual reader displays selected Unicode text and no peer payload');
                                require(document.body.includes('NativeSpeaker'), 'semantic speaker text retained');
                                if (current.snippet.firstMatchText) {
                                    await TestUtils.waitForCondition(() => browser.contentWindow.getSelection().toString() === current.snippet.firstMatchText,
                                        'real findbar selects captured snippet');
                                }
                                value = {factorySidecar: d.factorySidecar, originalSidecar: f.chatSidecar,
                                    hit: current.hit, document, resolved: {id: resolved.id, contentRevision: resolved.contentRevision,
                                        textRevision: resolved.textRevision}, body, rendered, loaded, displayed, privacy: await privacy()};
                            } finally {
                                Services.obs.removeObserver(observer, 'conversation-loaded');
                                browser.removeEventListener('MessagesDisplayed', onDisplayed);
                            }
                        } else if (phase === 'cleanup') {
                            let closeError;
                            try { await closeLive(); } catch (error) { closeError = error; }
                            try {
                                if (d.mail?.excluded && Number.isInteger(d.excludedFlags)) {
                                    core.folderDB.updateFlags(d.mail.excluded.folderId, d.excludedFlags);
                                }
                            } catch (error) { failures.push(error); }
                            delete root.__s717PolicyTrial;
                            if (closeError) { throw closeError; }
                            value = {closed: true, privacyRetained: true};
                        } else { throw new Error('Unknown S717 phase: ' + phase); }
                    } catch (error) { failure = error; }
                    for (const result of await Promise.allSettled([mail?.close(), provider?.close()])) {
                        if (result.status === 'rejected') { failures.push(result.reason); }
                    }
                    if (failure) { failures.unshift(failure); }
                    if (failures.length) { throw new AggregateError(failures, 'S717 operation/close failed'); }
                    return value;
                } catch (error) {
                    intakeFailed = true;
                    intakeError = error;
                    throw error;
                } finally {
                    if (intakeFailed || phase === 'close' || phase === 'cleanup') {
                        try { restoreModules(); }
                        catch (error) {
                            if (intakeFailed) {
                                throw new AggregateError([intakeError, error], 'S717 operation and test-module restoration failed');
                            }
                            throw error;
                        }
                    }
                }
            })().then(value => done({value}), error => {
                const describe = item => ({name: item.name, message: item.message, result: item.result,
                    stack: item.stack, errors: item.errors?.map(describe)});
                done({error: describe(error)});
            });
            """,
            script_args=[self.fixture, phase, self.s717_inputs],
            script_timeout=120000,
        )
        self.assertNotIn("error", result, json.dumps(result, ensure_ascii=True))
        return result["value"]

    def run_s717_policy_rebuild(self):
        """Apply all fixed mutations in the same profile after the intact S716 trial."""
        expected = {
            "version": 1,
            "mail": {
                "edit": {
                    "messageId": "s717-edit@example.invalid",
                    "folder": "S717Edit",
                    "oldSubject": "s717oldsubject",
                    "newSubject": "s717newsubject",
                    "body": "s717editbody",
                },
                "deleted": {
                    "messageId": "s717-delete@example.invalid",
                    "folder": "S717Delete",
                    "subject": "s717deletesubject",
                    "body": "s717deletedbody",
                },
                "excluded": {
                    "messageId": "s717-exclude@example.invalid",
                    "folder": "S717Exclude",
                    "subject": "s717excludesubject",
                    "body": "s717excludedbody",
                },
                "open": {
                    "messageId": "s717-selected@example.invalid",
                    "folders": ["S717Selected", "S717OtherCopy"],
                    "subject": "s717selectedsubject",
                    "body": "s717selectedbody café é 😀",
                },
            },
            "chat": {
                "account": "s717-policy",
                "conversation": "buddy",
                "edit": {
                    "remoteId": "edit",
                    "oldText": "s717chatoldneedle",
                    "newText": "s717chatnewneedle café é 😀",
                },
                "deleted": {"remoteId": "deleted", "text": "s717chatdeletedneedle"},
                "noLog": {"remoteId": "nolog", "text": "s717chatnologneedle"},
                "redacted": {"remoteId": "redacted", "text": "s717chatredactedneedle"},
                "keep": {"remoteId": "keep", "text": "s717chatkeepneedle café é 😀"},
                "otherPhysical": "s717otherphysicalneedle",
            },
        }
        self.assertEqual({key: self.fixture["s717"][key] for key in expected}, expected)
        self.s717_inputs = {"profile": str(self.profile), "work": str(self.work)}
        failure = None
        try:
            inputs = self.s717_operation("inputs")
            self.s717_inputs = inputs["inputs"]
            self.record("s717-inputs", inputs)
            target_ids = self.mail_ids | {row["id"] for row in self.s717_inputs["mail"].values()}
            history = []
            for batch in range(200):
                result = self.s717_operation("update")
                progress = result["progress"]
                current = self.snapshot("mailSidecar")
                self.assert_progress(progress, current)
                history.append(progress)
                versions = {row["documentId"]: row for row in current["document_versions"]}
                native = {row["id"]: row for row in result["identity"]["members"]}
                pending = {
                    row["documentId"]
                    for row in current["index_jobs"]
                    if row["status"] == "pending"
                }
                through = max(
                    progress["acceptedThrough"], current["work_state"][0]["rescanSequence"] or 0
                )
                completed = self.s717_completed(current, versions, native, pending, through)
                unaccepted = {
                    key
                    for key, state in native.items()
                    if key not in versions or versions[key]["sequence"] < state["generation"]
                }
                unfinished = (pending | unaccepted) & target_ids
                if completed and unfinished - set(completed):
                    break
            else:
                self.record("s717-checkpoint-unsettled", {"history": history, "mail": current})
                self.fail("S717 never reached a genuine completed/unfinished checkpoint")
            self.assertTrue(completed)
            self.assertTrue(unfinished - set(completed))
            self.record(
                "s717-checkpoint",
                {
                    "history": history,
                    "mail": current,
                    "identity": result["identity"],
                    "completed": completed,
                    "unfinished": sorted(unfinished),
                },
            )
            mutations = self.s717_operation("mutations")
            self.record("s717-mutations", mutations)
            by_id = {row["id"]: row for row in mutations["identity"]["members"]}
            self.assertIs(by_id[self.s717_inputs["mail"]["deleted"]["id"]]["deleted"], True)
            self.assertTrue(
                by_id[self.s717_inputs["mail"]["excluded"]["id"]]["folderFlags"]
                & mutations["junkFlag"]
            )
            self.assertTrue(mutations["queuedReadCancelled"])
            cancelled = self.s717_operation("cancel")
            self.assertIs(cancelled["cancelled"], True)
            mail = self.snapshot("mailSidecar")
            chat = self.snapshot("chatSidecar")
            recovered = next(
                row
                for row in mail["documents"]
                if row["documentId"] == self.fixture["recovered"]["id"]
            )
            self.assertEqual(recovered["body"], self.fixture["recovered"]["body"])
            self.record("s717-cancelled", {"result": cancelled, "mail": mail, "chat": chat})
            before = self.s717_operation("close")
            self.record("s717-before-restart", {"identity": before, "mail": mail, "chat": chat})
            shutdown = self.stop()
            self.assertEqual(self.snapshot("mailSidecar"), mail)
            self.assertEqual(self.snapshot("chatSidecar"), chat)
            self.marionette.start_session(capabilities=self.capabilities)
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            after = self.s717_operation("resumed")
            self.assertEqual(Path(after["identity"]["profile"]).resolve(), self.profile)
            self.assertEqual(after["identity"]["pid"], self.marionette.process_id)
            self.assertNotEqual(before["identity"]["pid"], after["identity"]["pid"])
            self.assertEqual(after["identity"]["sourceId"], self.fixture["sourceId"])
            self.assertEqual(after["identity"]["members"], before["identity"]["members"])
            self.assertEqual(after["privacy"], before["privacy"])
            self.assertEqual(self.snapshot("mailSidecar"), mail)
            self.assertEqual(self.snapshot("chatSidecar"), chat)
            self.assert_source_hashes()
            self.assert_receipt_keys()
            self.record(
                "s717-resumed-before-advance",
                {
                    "before": before,
                    "after": after,
                    "shutdown": shutdown,
                    "mail": mail,
                    "chat": chat,
                },
            )
            history, stable, stable_versions = [], {}, {}
            previous = None
            for batch in range(200):
                result = self.s717_operation("update")
                progress = result["progress"]
                current = self.snapshot("mailSidecar")
                self.assert_progress(progress, current)
                if previous is not None:
                    self.assertGreaterEqual(
                        progress["acceptedThrough"], previous["acceptedThrough"]
                    )
                    self.assertGreaterEqual(
                        progress["sourceWatermark"], previous["sourceWatermark"]
                    )
                previous = progress
                history.append(progress)
                rows = {row["documentId"]: row for row in current["documents"]}
                versions = {row["documentId"]: row for row in current["document_versions"]}
                for key, row in stable.items():
                    self.assertEqual(rows[key], row, "Completed current text is not replayed")
                    self.assertEqual(versions[key], stable_versions[key])
                native = {
                    row["id"]: row
                    for row in result["identity"]["members"]
                    if not row.get("deleted")
                }
                pending = {
                    row["documentId"]
                    for row in current["index_jobs"]
                    if row["status"] == "pending"
                }
                through = max(
                    progress["acceptedThrough"], current["work_state"][0]["rescanSequence"] or 0
                )
                for key, row in self.s717_completed(
                    current, versions, native, pending, through
                ).items():
                    stable.setdefault(key, row)
                    stable_versions.setdefault(key, versions[key])
                if (
                    not progress["pending"]
                    and not progress["rebuilding"]
                    and progress["acceptedThrough"] == progress["sourceWatermark"]
                ):
                    break
            else:
                self.record("s717-resume-unsettled", {"history": history, "mail": current})
                self.fail("S717 did not settle within 200 bounded real batches")
            self.assertTrue(stable)
            self.assertFalse(progress["moreWork"])
            self.assertEqual(progress["unavailable"], 3)
            self.assertIsNone(current["work_state"][0]["rescanSequence"])
            forbidden = {self.s717_inputs["mail"][name]["id"] for name in ("deleted", "excluded")}
            self.assertEqual(
                {row["documentId"] for row in current["documents"]}, target_ids - forbidden
            )
            self.record("s717-settled", {"history": history, "mail": current, "noReplay": stable})
            self.record("s717-mail-open", self.s717_operation("mail-final"))
            self.record("s717-chat-open", self.s717_operation("chat-final"))
            rebuilt = self.s717_rebuild_projection()
            self.record(
                "s717-final",
                {
                    "rebuild": rebuilt,
                    "mail": self.s717_operation("mail-final"),
                    "chat": self.s717_operation("chat-final"),
                },
            )
            self.assert_source_hashes()
            self.assert_receipt_keys()
            self.assertEqual(self.digest(Path(self.fixture["journalPath"])), self.journal_hash)
        except BaseException as error:
            failure = error
            raise
        finally:
            try:
                if not self.marionette.session:
                    self.marionette.start_session(capabilities=self.capabilities)
                    self.marionette.set_context(self.marionette.CONTEXT_CHROME)
                self.record("s717-cleanup", self.s717_operation("cleanup"))
            except BaseException as cleanup_error:
                if failure is not None:
                    raise cleanup_error from failure
                raise

    def s717_completed(self, snapshot, versions, native, pending, through):
        """Select only delivered current native tokens with completed body jobs."""
        return {
            row["documentId"]: row
            for row in snapshot["documents"]
            if row["bodyIndexed"]
            and row["documentId"] not in pending
            and row["documentId"] in versions
            and row["documentId"] in native
            and versions[row["documentId"]]["kind"] == "index"
            and row["changeSequence"] == versions[row["documentId"]]["sequence"]
            and native[row["documentId"]]["generation"]
            <= versions[row["documentId"]]["sequence"]
            <= through
            and all(
                row[key] == versions[row["documentId"]][key] == native[row["documentId"]][key]
                for key in ("generation", "policyRevision")
            )
            and row["contentRevision"] == native[row["documentId"]]["contentRevision"]
        }

    def s717_rebuild_projection(self):
        """Rebuild disposable projections without changing source authority or bounds."""
        result = self.marionette.execute_async_script(
            """
            const [f, inputs] = arguments;
            const done = arguments[arguments.length - 1];
            (async () => {
                const { FileUtils } = ChromeUtils.importESModule('resource://gre/modules/FileUtils.sys.mjs');
                const { MailSearchService } = ChromeUtils.importESModule('resource:///modules/panorama/MailSearchService.sys.mjs');
                const { ChatSearchProvider } = ChromeUtils.importESModule('resource:///modules/panorama/ChatSearchProvider.sys.mjs');
                const { closeChatSearch } = ChromeUtils.importESModule('resource:///modules/panorama/ChatSearchService.sys.mjs');
                const core = Cc['@mozilla.org/mailnews/database-core;1'].getService(Ci.nsIDatabaseCore);
                let mail, chat, factory, failure, progress;
                try {
                    await closeChatSearch();
                    mail = await MailSearchService.open(new FileUtils.File(f.mailSidecar), core.sourceId, core.messageDB);
                    chat = await ChatSearchProvider.open(new FileUtils.File(f.chatSidecar));
                    factory = await ChatSearchProvider.open(new FileUtils.File(inputs.factorySidecar));
                    await mail.rebuild();
                    await chat.rebuild();
                    await factory.rebuild();
                    for (let batch = 0; batch < 200; batch++) {
                        progress = await mail.update({limit: 2});
                        if (!progress.pending && !progress.rebuilding && progress.acceptedThrough === progress.sourceWatermark) { break; }
                    }
                    if (progress.pending || progress.rebuilding || progress.acceptedThrough !== progress.sourceWatermark) {
                        throw new Error('S717 projection rebuild exceeded 200 bounded batches');
                    }
                    const old = await chat.getText(f.chat.id);
                    const records = await chat.getRecoveryRecords(f.chat.id);
                    if (old?.body !== f.chat.expectedBody || records.length !== 1 ||
                        records[0].payload.disposition !== 'quarantined') {
                        throw new Error('S717 changed immutable S716 log or quarantine provenance');
                    }
                } catch (error) { failure = error; }
                const errors = (await Promise.allSettled([mail?.close(), chat?.close(), factory?.close()]))
                    .filter(result => result.status === 'rejected').map(result => result.reason);
                if (failure) { errors.unshift(failure); }
                if (errors.length) { throw new AggregateError(errors, 'S717 projection/close failed'); }
                return progress;
            })().then(value => done({value}), error => {
                const describe = item => ({name: item.name, message: item.message, stack: item.stack,
                    errors: item.errors?.map(describe)});
                done({error: describe(error)});
            });
            """,
            script_args=[self.fixture, self.s717_inputs],
            script_timeout=120000,
        )
        self.assertNotIn("error", result, json.dumps(result, ensure_ascii=True))
        self.assertFalse(result["value"]["moreWork"])
        return result["value"]

    def restore_fixture(self):
        """Close writers, restore retained streams, then restore the runner."""
        instance = self.marionette.instance
        try:
            if not self.marionette.session:
                self.marionette.start_session(capabilities=self.capabilities)
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            if instance.profile is self.trial_profile:
                for pref in self.saved_prefs:
                    if pref["hadValue"]:
                        self.marionette.set_pref(pref["name"], pref["value"])
                    else:
                        self.marionette.clear_pref(pref["name"])
        finally:
            try:
                if self.marionette.session:
                    self.stop()
                self.assertFalse(
                    self.marionette.instance.runner.is_running(),
                    "Owned streams may only be restored after normal writer exit",
                )
                for body, held, expected in self.held:
                    self.assertFalse(held.is_symlink())
                    self.assertTrue(held.is_file())
                    self.assertEqual(self.digest(held), expected)
                    self.assertEqual(body.resolve(), body)
                    self.assertEqual(held.resolve(), held)
                    self.assertFalse(body.is_symlink())
                    self.assertTrue(body.is_file())
                    placeholder = body.stat()
                    self.assertEqual(
                        (placeholder.st_dev, placeholder.st_ino), self.placeholders[body]
                    )
                    self.assertEqual(placeholder.st_size, 0)
                    self.assertEqual(
                        self.digest(body),
                        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    )
                    body.unlink()
                    self.assertFalse(
                        body.exists(), "Cleanup must never overwrite an existing source"
                    )
                    # Link creation refuses an unexpected destination atomically.
                    # Keep the retained payload until the restored bytes are checked.
                    body.hardlink_to(held)
                    self.assertTrue(body.samefile(held))
                    self.assertEqual(self.digest(body), expected)
                    held.unlink()
                if self.trial_profile is not None:
                    # Remove only this Profile object's required-pref markers.
                    # restore=False keeps the original native storage and receipts.
                    self.trial_profile.clean_preferences()
            finally:
                instance.prefs = self.instance_prefs
                try:
                    self.assertFalse(instance.runner.is_running())
                    instance.profile = self.initial_profile
                finally:
                    self.initial_profile.restore = self.initial_profile_restore
            self.assertIs(instance.profile, self.initial_profile)
            self.marionette.start_session(capabilities=self.capabilities)
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
