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
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.instance_prefs = self.marionette.instance.prefs
        self.capabilities = dict(self.marionette.requested_capabilities)
        self.initial_profile = self.marionette.instance.profile
        self.initial_profile_restore = self.initial_profile.restore
        self.trial_profile = None
        self.held = []
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
        self.assert_identity()
        self.validate_fixture()
        self.assert_source_hashes()
        self.journal_hash = self.digest(Path(self.fixture["journalPath"]))
        self.assert_receipt_keys()

    def cleanTest(self):
        """Use Marionette's actual end hook, including a failed setUp."""
        try:
            if hasattr(self, "initial_profile"):
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
        self.assertEqual(self.owned_path(f["work"]), self.work)
        for key, name in [("mailSidecar", "mail.sqlite"), ("chatSidecar", "chat.sqlite")]:
            self.assertEqual(self.owned_path(f[key]), self.work / name)
        for folder in f["folders"]:
            body = self.owned_path(folder["bodyPath"])
            if folder["heldPath"] is not None:
                held = self.owned_path(folder["heldPath"])
                self.assertEqual(held, Path(str(body) + ".s716-held"))
                self.assertFalse(body.exists(), "Only the imported original stream is held")
                self.assertTrue(held.is_file())
                self.held.append((body, held, self.digest(held)))
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
                    members: arguments[0].map(({id}) => {
                        const state = core.messageDB.getSearchState(Number(id));
                        return {id, folderId: state.folderId, generation: state.generation,
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
            raw_policy = member["rawPolicyRevision"]
            policy = member["policyRevision"]
            self.assertIs(type(raw_policy), str)
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
                        value = await mail.update({limit: 1});
                    } else if (phase === 'final') {
                        await mail.rebuild();
                        let progress;
                        for (let batch = 0; batch < 200; batch++) {
                            progress = await mail.update({limit: 1});
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
        initial = self.snapshot("mailSidecar")
        self.record("marionette-initial", initial)
        history = []
        for batch in range(200):
            progress = self.operation("update")
            mail = self.snapshot("mailSidecar")
            self.assert_progress(progress, mail)
            history.append(progress)
            pending_ids = {r["documentId"] for r in mail["index_jobs"]}
            completed = {
                r["documentId"]: r
                for r in mail["documents"]
                if r["bodyIndexed"] and r["documentId"] not in pending_ids
            }
            remaining = (
                progress["pending"]
                or progress["acceptedThrough"] < progress["sourceWatermark"]
                or mail["work_state"][0]["rescanSequence"] is not None
            )
            if completed and remaining:
                break
        else:
            self.record("marionette-checkpoint-unsettled", history)
            self.fail("The fixed corpus never produced a completed-and-unfinished checkpoint")
        self.assertTrue(set(completed).issubset(self.mail_ids))
        chat = self.snapshot("chatSidecar")
        before = self.assert_identity()
        native = {row["id"]: row for row in before["members"]}
        versions = {row["documentId"]: row for row in mail["document_versions"]}
        self.assertEqual(set(native), self.mail_ids)
        for key, document in completed.items():
            self.assertEqual(versions[key]["kind"], "index")
            self.assertEqual(document["changeSequence"], versions[key]["sequence"])
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
                    if held.exists():
                        self.assertFalse(
                            body.exists(), "Cleanup must never overwrite an existing source"
                        )
                        self.assertEqual(self.digest(held), expected)
                        held.rename(body)
                        self.assertEqual(self.digest(body), expected)
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
