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
        self.run_s717_policy_cancel_restart_query_open(result)

    def s717_operation(self, phase, data=None):
        """Run the finite S717 phases in their owning real application window."""
        result = self.marionette.execute_async_script(
            r"""
            const [f, phase, input] = arguments;
            const done = arguments[arguments.length - 1];
            (async () => {
                const { FileUtils } = ChromeUtils.importESModule('resource://gre/modules/FileUtils.sys.mjs');
                const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
                const { MailSearchService } = ChromeUtils.importESModule('resource:///modules/panorama/MailSearchService.sys.mjs');
                const { ChatSearchProvider, chatSearchDocumentId } = ChromeUtils.importESModule('resource:///modules/panorama/ChatSearchProvider.sys.mjs');
                const { getChatSearchService, findChatSearchResults, closeChatSearch } = ChromeUtils.importESModule('resource:///modules/panorama/ChatSearchService.sys.mjs');
                const logger = ChromeUtils.importESModule('resource:///modules/logger.sys.mjs');
                const { Message } = ChromeUtils.importESModule('resource:///modules/jsProtoHelper.sys.mjs');
                const { imMessage } = ChromeUtils.importESModule('resource:///modules/imConversations.sys.mjs');
                const { persistChatSearchRedaction } = ChromeUtils.importESModule('resource:///modules/panorama/ChatSearchRedaction.sys.mjs');
                const core = Cc['@mozilla.org/mailnews/database-core;1'].getService(Ci.nsIDatabaseCore);
                const win = Services.wm.getMostRecentWindow('mail:3pane');
                const tabmail = win.document.getElementById('tabmail');
                const c = f.s717;
                const check = (condition, message) => {
                    if (!condition) {
                        throw new Error('S717 ' + message);
                    }
                };
                const waitForCondition = async (condition, message) => {
                    for (let attempt = 0; attempt < 50; attempt++) {
                        const value = await condition();
                        if (value) {
                            return value;
                        }
                        await new Promise(resolve => win.setTimeout(resolve, 100));
                    }
                    throw new Error('S717 ' + message + ' - timed out after 50 tries');
                };
                check(core.sourceId === f.sourceId, 'native source incarnation');
                const profile = Services.dirsvc.get('ProfD', Ci.nsIFile);
                profile.normalize();
                check(profile.path === f.profile, 'actual retained ProfD');
                let s = win.__s717;
                if (phase === 'inputs' || phase === 'reopen') {
                    check(!s, 'one owner per process');
                    s = win.__s717 = {data: input, writers: [], tabs: new Set(),
                        initialTabs: new Set(tabmail.tabInfo),
                        controllers: new Set(), waits: new Set(), releases: new Set()};
                }
                check(s, 'live process owns this phase');
                const identity = () => ({profile: profile.path, sourceId: core.sourceId,
                    pid: Services.appinfo.processID,
                    native: Services.prefs.getBoolPref('mail.panorama.enabled'),
                    indexing: Services.prefs.getBoolPref('mailnews.database.global.indexer.enabled'),
                    watermark: core.messageDB.getSearchChanges(0, 1).watermark,
                    members: [...f.mail, ...(s.data?.mail || [])].map(row => ({
                        id: row.id, folderId: row.folderId,
                        raw: core.messageDB.getSearchState(Number(row.id))}))});
                const emit = (fixture, remoteId, text, properties = {}) => {
                    const message = new imMessage(new Message(c.chat.speaker, text, {
                        incoming: true, remoteId, displayMessage: text,
                        time: fixture.conversation.startDate / 1000000 + 1,
                        ...properties,
                    }, fixture.conversation));
                    check(message.QueryInterface(Ci.imIMessage).displayMessage === text,
                        'production IM message exposes the exact logger display text');
                    check(message.QueryInterface(Ci.imIMessage).conversation.id === fixture.conversation.id,
                        'typed IM message retains the owned numeric conversation identity');
                    Services.obs.notifyObservers(message, 'new-text');
                    return message;
                };
                let mail, chat, value, failure;
                try {
                    if (!['identity', 'privacy', 'reopen', 'before-restart', 'cleanup'].includes(phase)) {
                        mail = await MailSearchService.open(new FileUtils.File(f.mailSidecar), core.sourceId, core.messageDB);
                    }
                    if (['inputs', 'mutations', 'cancel', 'corpus', 'projection'].includes(phase)) {
                        chat = await ChatSearchProvider.open(new FileUtils.File(f.chatSidecar));
                    }
                    if (phase === 'inputs') {
                        const prefs = [
                            ['mail.chat.enabled', true],
                            ['gloda.show_as_list_by_default', false],
                            ['mail.openMessageBehavior', 2],
                            ['mailnews.mark_message_read.auto', false],
                        ].map(([name, setting]) => {
                            const integer = typeof setting === 'number';
                            const saved = {name, integer, hadValue: Services.prefs.prefHasUserValue(name),
                                value: integer ? Services.prefs.getIntPref(name) : Services.prefs.getBoolPref(name, false)};
                            if (integer) {
                                Services.prefs.setIntPref(name, setting);
                            } else {
                                Services.prefs.setBoolPref(name, setting);
                            }
                            return saved;
                        });
                        s.data = {mail: [], logs: [], prefs};
                        const root = MailServices.accounts.localFoldersServer.rootFolder;
                        for (const role of ['edit', 'deleted', 'excluded', 'open', 'other']) {
                            const expected = c.mail[role === 'other' ? 'open' : role];
                            const name = expected.folder || expected.folders[role === 'other' ? 1 : 0];
                            const folder = root.getChildNamed(name).QueryInterface(Ci.nsIMsgLocalMailFolder);
                            check(folder.id === c.folders[name].id && folder.URI === c.folders[name].uri,
                                'fixed empty physical folder ' + role);
                            check(core.folderDB.getFolderFlags(folder.id) === c.folders[name].originalFlags,
                                'original native folder flags ' + role);
                            check(folder.getTotalMessages(false) === 0, 'fresh mutable folder ' + role);
                            const raw = ['From: S717 Sender <sender@example.invalid>',
                                'To: S717 Recipient <recipient@example.invalid>',
                                'Date: Tue, 01 Jan 2019 00:00:00 +0000',
                                'Message-ID: <' + expected.messageId + '>',
                                'Subject: ' + (expected.oldSubject || expected.subject),
                                'Content-Type: text/plain; charset=utf-8', '', expected.body, ''].join('\r\n');
                            const bytes = new TextEncoder().encode(raw);
                            const header = folder.addMessage(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
                            s.data.mail.push({role, id: String(header.messageKey), folderId: folder.id,
                                folderURI: folder.URI, messageId: header.messageId});
                        }
                        const shared = await getChatSearchService();
                        const now = Date.now();
                        for (const [offset, role] of ['selected', 'other'].entries()) {
                            const conversation = {id: 717000 + offset, title: 'S717 policy conversation',
                                name: c.chat.conversation, normalizedName: c.chat.conversation,
                                isChat: false, startDate: (now + offset * 2000) * 1000,
                                account: {id: c.chat.account, normalizedName: c.chat.account,
                                    protocol: {normalizedName: 'search-test'}}};
                            const writer = logger.getLogWriter(conversation);
                            const fixture = {conversation, writer};
                            s.writers.push(fixture);
                            await writer._initialized;
                            if (role === 'selected') {
                                for (const name of ['edit', 'deleted', 'noLog', 'redacted', 'keep']) {
                                    const expected = c.chat[name];
                                    emit(fixture, expected.remoteId, expected.oldText || expected.text);
                                }
                            } else {
                                emit(fixture, c.chat.keep.remoteId, c.chat.otherPhysical);
                            }
                            await shared.flush();
                            const path = writer.currentPath;
                            await logger.gFilePromises.get(path);
                            await chat.refreshLog(path);
                            const logged = await chat.getText(chatSearchDocumentId(path));
                            const ownText = role === 'selected' ? c.chat.keep.text : c.chat.otherPhysical;
                            const otherText = role === 'selected' ? c.chat.otherPhysical : c.chat.keep.text;
                            check(logged && logged.body.includes(ownText) && !logged.body.includes(otherText),
                                'actual writer stores only its independent physical input ' + role);
                            s.data.logs.push({role, path, id: chatSearchDocumentId(path), conversationId: conversation.id});
                        }
                        check(s.data.logs[0].id !== s.data.logs[1].id, 'distinct physical logs with equal logical scope');
                        const old = await findChatSearchResults(c.chat.edit.oldText);
                        s.data.oldChatItem = old.items.find(item => item.hit.id === s.data.logs[0].id);
                        check(s.data.oldChatItem, 'captured old hit from the actual shared factory');
                        check(s.data.oldChatItem.document.body.includes(c.chat.edit.oldText), 'independent old chat input');
                        s.data.sharedSidecar = PathUtils.join(profile.path, 'panorama-chat-search.sqlite');
                        check(s.data.sharedSidecar !== f.chatSidecar, 'shared and dedicated sidecar identities');
                        await mail.rebuild();
                        value = {inputs: s.data, identity: identity()};
                    } else if (phase === 'privacy') {
                        value = await logger.getChatPrivacyState();
                    } else if (phase === 'identity' || phase === 'reopen') {
                        value = identity();
                    } else if (phase === 'update') {
                        value = await mail.update({limit: 2});
                    } else if (phase === 'mutations') {
                        const rows = Object.fromEntries(s.data.mail.map(row => [row.role, row]));
                        check(core.messageDB.getMessage(Number(rows.edit.id)).subject === c.mail.edit.oldSubject,
                            'original edit subject');
                        core.messageDB.getMessage(Number(rows.edit.id)).subject = c.mail.edit.newSubject;
                        core.messageDB.removeMessage(Number(rows.deleted.id));
                        const flags = core.folderDB.getFolderFlags(rows.excluded.folderId);
                        check(flags === c.folders[c.mail.excluded.folder].originalFlags, 'owned exclusion flags before mutation');
                        core.folderDB.updateFlags(rows.excluded.folderId, flags | Ci.nsMsgFolderFlags.Trash);
                        const fixture = s.writers[0];
                        const shared = await getChatSearchService();
                        emit(fixture, c.chat.edit.remoteId, c.chat.edit.newText);
                        await shared.flush();
                        const paths = {};
                        for (const role of ['deleted', 'noLog', 'redacted']) {
                            const expected = c.chat[role];
                            const properties = role === 'deleted' ? {deleted: true} : {noLog: true};
                            let message;
                            if (role === 'redacted') {
                                message = new imMessage(new Message(c.chat.speaker, '', {incoming: true,
                                    remoteId: expected.remoteId, displayMessage: '', noLog: true,
                                    time: fixture.conversation.startDate / 1000000 + 1}, fixture.conversation));
                                // Capture the original version before explicit source erasure.
                                logger.logs.observe(message, 'new-text');
                                await logger.captureChatPrivacyIntent(message);
                                paths[role] = await persistChatSearchRedaction(message);
                                check(paths[role].includes(s.data.logs[0].path), 'redaction changed the owned live writer path');
                                Services.obs.notifyObservers(message, 'new-text');
                                await shared.flush();
                                await logger.getChatPrivacyState();
                                await chat.redactMessage(message);
                            } else {
                                message = emit(fixture, expected.remoteId, '', properties);
                                // Complete the observer owner's acknowledgement before the
                                // dedicated sidecar performs its own idempotent erasure.
                                await shared.flush();
                                await logger.getChatPrivacyState();
                                paths[role] = await chat.redactMessage(message);
                                check(paths[role].includes(s.data.logs[0].path), 'durable privacy target ' + role);
                            }
                            await shared.flush();
                        }
                        await chat.refreshLog(s.data.logs[0].path);
                        value = {identity: identity(), paths, privacy: await logger.getChatPrivacyState(),
                            nativeChanges: core.messageDB.getSearchChanges(input.afterSequence, 200),
                            excluded: {eligible: mail.resolveDocument(rows.excluded.id).eligible,
                                text: await mail.getText(rows.excluded.id)},
                            deletedText: await mail.getText(rows.deleted.id)};
                    } else if (phase === 'cancel') {
                        const controller = new AbortController();
                        s.controllers.add(controller);
                        const reason = new Error('S717 cancel the live bounded mail update');
                        let settled = false;
                        const operation = mail.update({limit: 2, signal: controller.signal});
                        const tracked = operation.then(
                            () => { settled = true; return {resolved: true}; },
                            error => { settled = true; return {sameReason: error === reason, name: error.name}; }
                        );
                        s.waits.add(tracked);
                        await Promise.resolve();
                        await Promise.resolve();
                        const pendingAtAbort = !settled && !controller.signal.aborted;
                        controller.abort(reason);
                        const cancellation = await tracked;
                        s.waits.delete(tracked);
                        check(pendingAtAbort, 'non-preaborted update remains pending after its queued operation starts');
                        check(cancellation.sameReason === true, 'original mail cancellation reason identity');
                        const log = s.data.logs[1];
                        const path = log.path;
                        check(log.role === 'other' && path !== s.data.logs[0].path,
                            'queued cancellation owns the other physical mutable log');
                        const privacyBeforeRead = await logger.getChatPrivacyState();
                        check([...privacyBeforeRead.pending, ...privacyBeforeRead.completed].every(receipt =>
                            receipt.targets.every(target =>
                                PathUtils.join(profile.path, 'logs', ...target.relativePath) !== path)),
                            'held peer log is outside every completed or pending privacy target');
                        const entered = Promise.withResolvers();
                        const gate = Promise.withResolvers();
                        s.releases.add(gate.resolve);
                        const held = logger.queueFileOperation(path, async () => {
                            entered.resolve();
                            await gate.promise;
                        });
                        let read, readResult, queued = false;
                        const readController = new AbortController();
                        s.controllers.add(readController);
                        const readReason = new Error('S717 cancel the actual queued log read');
                        try {
                            await entered.promise;
                            read = chat.refreshLog(path, {signal: readController.signal}).then(
                                () => ({resolved: true}), error => ({sameReason: error === readReason, name: error.name})
                            );
                            s.waits.add(read);
                            await waitForCondition(() => logger.gFilePromises.get(path) !== held,
                                'S717 provider source read reaches the held owned peer file queue');
                            queued = logger.gFilePromises.get(path) !== held;
                            check(queued, 'real source read queued behind the held physical path');
                            readController.abort(readReason);
                        } finally {
                            readController.abort(readReason);
                            gate.resolve();
                            s.releases.delete(gate.resolve);
                            const results = await Promise.allSettled([held, read, logger.gFilePromises.get(path)]);
                            const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
                            if (errors.length) {
                                throw new AggregateError(errors, 'S717 held source drain failed');
                            }
                            readResult = results[1].value;
                            s.waits.delete(read);
                        }
                        check(readResult?.sameReason === true, 'original queued log cancellation reason identity');
                        value = {pendingAtAbort, cancellation, queued, readResult, readPath: path, readId: log.id,
                            identity: identity(), privacy: await logger.getChatPrivacyState()};
                    } else if (phase === 'projection') {
                        await mail.rebuild();
                        await chat.rebuild();
                        value = {identity: identity()};
                    } else if (phase === 'corpus') {
                        const rows = [];
                        for (const row of [...f.mail, ...s.data.mail]) {
                            const state = mail.resolveDocument(row.id);
                            rows.push({...row, raw: core.messageDB.getSearchState(Number(row.id)),
                                state: state && {eligible: state.eligible, generation: state.generation,
                                    contentRevision: state.contentRevision, policyRevision: state.policyRevision,
                                    location: state.location, originalContentAvailable: state.originalContentAvailable},
                                text: await mail.getText(row.id)});
                        }
                        const mailQueries = {};
                        for (const term of ['s717oldsubject', 's717newsubject', 's717editbody',
                            's717deletedbody', 's717deletesubject', 's717excludedbody', 's717excludesubject',
                            's717selectedbody', 'recovered', 'quarantineneedle', 'oldaggregateneedle']) {
                            const page = await mail.search(term, {limit: 100});
                            check(!page.cursor, 'finite mail query cohort');
                            mailQueries[term] = page.items;
                        }
                        const shared = await getChatSearchService();
                        await shared.flush();
                        const chatTexts = [];
                        for (const row of s.data.logs) {
                            await chat.refreshLog(row.path);
                            chatTexts.push({...row, text: await chat.getText(row.id),
                                sharedText: await shared.getText(row.id),
                                raw: await logger.queueFileOperation(row.path, () => IOUtils.readUTF8(row.path))});
                        }
                        const chatQueries = {};
                        for (const term of [c.chat.edit.oldText, 's717chatnewneedle', c.chat.deleted.text,
                            c.chat.noLog.text, c.chat.redacted.text, 's717chatkeepneedle',
                            c.chat.otherPhysical, f.chat.aggregateNeedle]) {
                            chatQueries[term] = {dedicated: (await chat.search(term, {limit: 100})).items,
                                shared: (await findChatSearchResults(term)).items};
                        }
                        value = {identity: identity(), rows, mailQueries, chatTexts, chatQueries,
                            privacy: await logger.getChatPrivacyState(),
                            originalChat: await chat.getText(f.chat.id),
                            recovered: await mail.getRecoveryRecords(),
                            chatRecovery: await chat.getRecoveryRecords(f.chat.id)};
                    } else if (phase === 'mail-open') {
                        const rows = Object.fromEntries(s.data.mail.map(row => [row.role, row]));
                        const count = tabmail.tabInfo.length;
                        const refusals = {};
                        for (const [role, expected] of [['deleted', 'deleted'], ['excluded', 'ineligible']]) {
                            const result = await mail.openResult(rows[role].id, {tabmail});
                            refusals[role] = result.status;
                            check(result.status === expected, 'current mail opening refuses ' + role);
                        }
                        const unavailable = await mail.openResult(f.recovered.id, {tabmail});
                        check(unavailable.status === 'unavailable', 'recovered-only original remains explicitly unavailable');
                        const controller = new AbortController();
                        s.controllers.add(controller);
                        const reason = new Error('S717 cancelled mail reader dispatch');
                        controller.abort(reason);
                        let sameReason = false;
                        try {
                            await mail.openResult(rows.open.id, {tabmail, signal: controller.signal});
                        } catch (error) {
                            sameReason = error === reason;
                        }
                        check(sameReason, 'cancelled mail opening preserves reason');
                        check(tabmail.tabInfo.length === count, 'refused mail opens add no tab or other copy');
                        const selected = rows.open;
                        const selectedHit = (await mail.search('s717selectedbody', {limit: 100})).items
                            .find(hit => hit.id === selected.id);
                        check(selectedHit, 'captured current hit for the selected physical MIME copy');
                        const peer = rows.other;
                        check(selected.id !== peer.id && selected.folderURI !== peer.folderURI &&
                            selected.messageId === peer.messageId, 'physical copies share only the logical Message-ID');
                        const before = new Set(tabmail.tabInfo);
                        const opened = await mail.openResult(selected.id, {tabmail});
                        for (const tab of tabmail.tabInfo) {
                            if (!before.has(tab)) {
                                s.tabs.add(tab);
                            }
                        }
                        check(opened.status === 'ready', 'selected current native MIME copy opens');
                        await waitForCondition(() => {
                            const reader = tabmail.currentAboutMessage;
                            return reader?.gMessage?.messageKey === Number(selected.id) &&
                                reader.gMessage.folder.URI === selected.folderURI &&
                                reader.getMessagePaneBrowser().contentDocument.body?.textContent.includes(c.mail.open.body);
                        }, 'S717 real mail reader displays the selected current physical MIME body');
                        const reader = tabmail.currentAboutMessage;
                        const state = core.messageDB.getSearchState(Number(selected.id));
                        const text = await mail.getText(selected.id);
                        check(text && text.id === selected.id && text.generation === state.generation &&
                            text.contentRevision === state.contentRevision && text.policyRevision === Number(state.policyRevision),
                            'selected mail query and reader retain current native policy/content');
                        for (const field of ['generation', 'contentRevision', 'policyRevision', 'textRevision']) {
                            check(selectedHit[field] === text[field], 'selected current mail hit token ' + field);
                        }
                        value = {selectedHit, status: opened.status, refusals, unavailable: unavailable.status,
                            cancelledSameReason: sameReason, sourceId: core.sourceId,
                            key: reader.gMessage.messageKey, folderURI: reader.gMessage.folder.URI,
                            messageId: reader.gMessage.messageId, raw: state, text,
                            displayed: reader.getMessagePaneBrowser().contentDocument.body.textContent};
                    } else if (phase === 'chat-open') {
                        const selected = s.data.logs[0];
                        const query = async (physical = selected, text = 's717chatkeepneedle') => {
                            const inputBox = win.document.querySelector('#unifiedToolbarContent global-search-bar');
                            check(inputBox, 'retained global search toolbar');
                            inputBox.popup.selectedIndex = -1;
                            inputBox.dispatchEvent(new win.CustomEvent('search', {detail: text}));
                            const tab = tabmail.currentTabInfo;
                            s.tabs.add(tab);
                            check(tab.mode.name === 'glodaFacet', 'real native result view');
                            await waitForCondition(() => tab.searchPromise, 'S717 real toolbar query begins');
                            check(await tab.searchPromise, 'real toolbar query succeeds');
                            const context = tab.browser.contentWindow.FacetContext;
                            const item = context.chatSearchResultSet.items.find(row => row.hit.id === physical.id);
                            check(item, 'shared-factory physical row in real facet view');
                            return {tab, context, item};
                        };
                        let view = await query();
                        let count = tabmail.tabInfo.length;
                        check(await view.context.openChatSearchConversation(s.data.oldChatItem) === null,
                            'captured pre-edit shared hit is refused by the real route');
                        check(tabmail.tabInfo.length === count, 'stale chat hit adds no reader tab');
                        const shared = await getChatSearchService();
                        let nullRefused = false, nullError = null;
                        try {
                            await shared.resolveLog(null);
                        } catch (error) {
                            nullError = {name: error.name, message: error.message, result: error.result ?? null};
                            nullRefused = nullError.name === 'TypeError' &&
                                nullError.message === 'A current chat search hit is required';
                        }
                        s.nullRequestRefusal = {error: nullError, beforeTabs: count, afterTabs: tabmail.tabInfo.length};
                        check(nullRefused && tabmail.tabInfo.length === count, 'null chat delivery is refused');
                        const peer = s.data.logs[1];
                        check(peer.role === 'other' && peer.id !== selected.id && peer.path !== selected.path,
                            'reader cancellation owns a distinct physical peer log');
                        const readerPrivacy = await logger.getChatPrivacyState();
                        check([...readerPrivacy.pending, ...readerPrivacy.completed].every(receipt =>
                            receipt.targets.every(target =>
                                PathUtils.join(profile.path, 'logs', ...target.relativePath) !== peer.path)),
                            'reader cancellation peer is outside every privacy target');
                        tabmail.closeTab(view.tab);
                        view = await query(peer, c.chat.otherPhysical);
                        const gate = Promise.withResolvers();
                        const entered = Promise.withResolvers();
                        s.releases.add(gate.resolve);
                        const held = logger.queueFileOperation(peer.path, async () => {
                            entered.resolve();
                            await gate.promise;
                        });
                        let opening, cancelled, queued = false;
                        const beforeCancelledOpen = new Set(tabmail.tabInfo);
                        try {
                            await entered.promise;
                            opening = view.context.openChatSearchConversation(view.item).then(
                                () => ({resolved: true}), error => ({name: error.name, message: error.message})
                            );
                            s.waits.add(opening);
                            await waitForCondition(() => logger.gFilePromises.get(peer.path) !== held,
                                'S717 real parent-owned peer open reaches its held file queue');
                            queued = logger.gFilePromises.get(peer.path) !== held;
                            check(queued, 'parent-owned open reaches the held physical log queue');
                            tabmail.closeTab(view.tab);
                            cancelled = await opening;
                            check(cancelled.name === 'AbortError', 'closing the real result tab aborts its parent-owned open');
                        } finally {
                            if (tabmail.tabInfo.includes(view.tab)) {
                                tabmail.closeTab(view.tab);
                            }
                            gate.resolve();
                            s.releases.delete(gate.resolve);
                            const drained = await Promise.allSettled([held, opening, logger.gFilePromises.get(peer.path)]);
                            const errors = drained.filter(row => row.status === 'rejected').map(row => row.reason);
                            s.waits.delete(opening);
                            for (const tab of tabmail.tabInfo) {
                                if (!beforeCancelledOpen.has(tab)) {
                                    s.tabs.add(tab);
                                }
                            }
                            if (errors.length) {
                                throw new AggregateError(errors, 'S717 reader queue drain failed');
                            }
                        }
                        await shared.getText(peer.id);
                        const cancelledNewTabs = tabmail.tabInfo.filter(tab => !beforeCancelledOpen.has(tab));
                        const cancelledAfterTabs = tabmail.tabInfo.length;
                        check(cancelledNewTabs.length === 0, 'cancelled open never adds a reader tab');
                        check(tabmail.currentTabInfo.mode.name !== 'chat', 'cancelled open never selects a chat reader');
                        view = await query();
                        const browser = win.document.getElementById('conv-log-browser');
                        let loaded = false;
                        let displayed = false;
                        const observer = subject => {
                            if (subject === browser) {
                                loaded = true;
                            }
                        };
                        const onDisplayed = () => { displayed = true; };
                        Services.obs.addObserver(observer, 'conversation-loaded');
                        browser.addEventListener('MessagesDisplayed', onDisplayed, {once: true});
                        const remove = () => {
                            Services.obs.removeObserver(observer, 'conversation-loaded');
                            browser.removeEventListener('MessagesDisplayed', onDisplayed);
                        };
                        s.stops ||= new Set();
                        s.stops.add(remove);
                        const before = new Set(tabmail.tabInfo);
                        try {
                            const row = [...view.tab.browser.contentDocument.querySelectorAll('.native-chat-result')]
                                .find(node => node.dataset.id === selected.id);
                            check(row, 'rendered physical chat row');
                            row.querySelector('button').click();
                            await view.tab.chatSearchOpenPromise;
                            await waitForCondition(() => loaded && displayed,
                                'S717 actual conversation-loaded and MessagesDisplayed events');
                            for (const tab of tabmail.tabInfo) {
                                if (!before.has(tab)) {
                                    s.tabs.add(tab);
                                }
                            }
                            const resolved = win.document.getElementById('searchResultConv').nativeChatLog.resolved;
                            check(tabmail.currentTabInfo.mode.name === 'chat', 'normal chat reader opens');
                            check(resolved.id === selected.id && resolved.log.path === selected.path,
                                'reader preserves selected canonical physical log');
                            check(resolved.contentRevision === view.item.hit.contentRevision &&
                                resolved.textRevision === view.item.hit.textRevision,
                                'reader resolves the current captured shared-factory revision');
                            const messages = browser._conv.getMessages()
                                .filter(message => !message.noLog)
                                .map(message => ({
                                who: message.alias || message.who, text: message.message}));
                            check(messages.some(message => message.text === c.chat.keep.text) &&
                                messages.some(message => message.text === c.chat.edit.newText),
                                'reader displays independent current non-ASCII selected content');
                            check(messages.every(message => message.who === c.chat.speaker), 'real reader preserves speaker text');
                            check(messages.every(message => message.text !== c.chat.otherPhysical), 'equal logical IDs never substitute another log');
                            value = {id: resolved.id, path: resolved.log.path,
                                contentRevision: resolved.contentRevision, textRevision: resolved.textRevision,
                                item: view.item, messages, cancelled, queued, nullRefused, nullError, cancelledId: peer.id, cancelledPath: peer.path,
                                cancelledBeforeTabs: beforeCancelledOpen.size, cancelledAfterTabs, cancelledNewTabs: cancelledNewTabs.length,
                                displayed: browser.contentDocument.body.textContent,
                                sharedSidecar: s.data.sharedSidecar, dedicatedSidecar: f.chatSidecar};
                        } finally {
                            remove();
                            s.stops.delete(remove);
                            for (const tab of tabmail.tabInfo) {
                                if (!before.has(tab)) {
                                    s.tabs.add(tab);
                                }
                            }
                        }
                    } else if (phase === 'before-restart' || phase === 'cleanup') {
                        // Release queued reads before any service/writer drain or quit.
                        for (const release of s.releases) {
                            release();
                        }
                        for (const controller of s.controllers) {
                            controller.abort(new Error('S717 owner cleanup'));
                        }
                        const errors = [];
                        const waits = await Promise.allSettled([...s.waits]);
                        errors.push(...waits.filter(row => row.status === 'rejected').map(row => row.reason));
                        for (const fixture of s.writers) {
                            try {
                                logger.closeLogWriter(fixture.conversation);
                            } catch (error) {
                                errors.push(error);
                            }
                        }
                        const writers = await Promise.allSettled(s.writers.flatMap(fixture =>
                            [...fixture.writer.paths].map(path => logger.gFilePromises.get(path))));
                        errors.push(...writers.filter(row => row.status === 'rejected').map(row => row.reason));
                        try {
                            await closeChatSearch();
                        } catch (error) {
                            errors.push(error);
                        }
                        for (const stop of s.stops || []) {
                            try {
                                stop();
                            } catch (error) {
                                errors.push(error);
                            }
                        }
                        for (const tab of tabmail.tabInfo) {
                            if (!s.initialTabs.has(tab)) {
                                s.tabs.add(tab);
                            }
                        }
                        for (const tab of s.tabs) {
                            try {
                                if (tabmail.tabInfo.includes(tab)) {
                                    tabmail.closeTab(tab);
                                }
                            } catch (error) {
                                errors.push(error);
                            }
                        }
                        if (phase === 'cleanup') {
                            try {
                                const folder = c.folders[c.mail.excluded.folder];
                                core.folderDB.updateFlags(folder.id, folder.originalFlags);
                                for (const pref of s.data?.prefs || []) {
                                    if (!pref.hadValue) {
                                        Services.prefs.clearUserPref(pref.name);
                                    } else if (pref.integer) {
                                        Services.prefs.setIntPref(pref.name, pref.value);
                                    } else {
                                        Services.prefs.setBoolPref(pref.name, pref.value);
                                    }
                                }
                            } catch (error) {
                                errors.push(error);
                            }
                        }
                        check(!logger.gFilePromises.has(s.data?.logs?.[0]?.path), 'owned physical log queue drained');
                        value = {identity: identity(), privacy: await logger.getChatPrivacyState(),
                            pendingWaits: s.waits.size, writerCount: s.writers.length, errors: errors.map(String),
                            nullRequestRefusal: s.nullRequestRefusal || null};
                        s.writers.length = 0;
                        s.tabs.clear();
                        if (phase === 'cleanup') {
                            delete win.__s717;
                        }
                        if (errors.length) {
                            throw new AggregateError(errors, 'S717 cleanup retains original drain/close errors');
                        }
                    } else {
                        throw new Error('Unknown S717 phase: ' + phase);
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
                    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'S717 operation/close failed');
                }
                return value;
            })().then(value => done({value}), error => {
                const describe = item => ({name: item.name, message: item.message,
                    result: item.result, stack: item.stack, errors: item.errors?.map(describe)});
                done({error: describe(error)});
            });
        """,
            script_args=[self.fixture, phase, data],
            script_timeout=120000,
        )
        if "error" in result:
            self.record("s717-error-" + phase, result)
        self.assertNotIn("error", result, json.dumps(result, ensure_ascii=True))
        return result["value"]

    def s717_identity(self):
        """Bind current raw native versions without the pre-policy S716 oracle."""
        actual = self.s717_operation("identity")
        self.assertEqual(Path(actual["profile"]).resolve(), self.profile)
        self.assertEqual(actual["sourceId"], self.fixture["sourceId"])
        self.assertEqual(actual["pid"], self.marionette.process_id)
        self.assertGreater(actual["pid"], 0)
        self.assertIs(actual["native"], True)
        self.assertIs(actual["indexing"], True)
        for row in actual["members"]:
            raw = row["raw"]
            if raw is not None:
                self.assertEqual(raw["messageKey"], int(row["id"]))
                self.assertEqual(raw["folderId"], row["folderId"])
                self.assertRegex(raw["policyRevision"], r"\A(?:0|[1-9][0-9]*)\Z")
                self.assertLessEqual(int(raw["policyRevision"]), 2**53 - 1)
        return actual

    def s717_start(self, expected):
        """Restart the same real profile against its newly captured policy state."""
        self.marionette.start_session(capabilities=self.capabilities)
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.s717_operation("reopen", self.s717_data)
        actual = self.s717_identity()
        self.assertNotEqual(actual["pid"], expected["pid"])
        for field in ("profile", "sourceId", "members", "watermark"):
            self.assertEqual(actual[field], expected[field], field)
        return actual

    def s717_completed(self, snapshot, identity, progress):
        """Identify accepted current physical text revisions from durable rows."""
        native = {row["id"]: row["raw"] for row in identity["members"]}
        versions = {row["documentId"]: row for row in snapshot["document_versions"]}
        pending = {row["documentId"] for row in snapshot["index_jobs"]}
        through = max(
            progress["acceptedThrough"], snapshot["work_state"][0]["rescanSequence"] or 0
        )
        completed = {}
        for row in snapshot["documents"]:
            key = row["documentId"]
            raw, version = native.get(key), versions.get(key)
            if (
                raw
                and version
                and row["bodyIndexed"]
                and key not in pending
                and version["kind"] == "index"
                and row["changeSequence"] == version["sequence"]
                and raw["generation"] <= version["sequence"] <= through
                and row["generation"] == version["generation"] == raw["generation"]
                and row["policyRevision"]
                == version["policyRevision"]
                == int(raw["policyRevision"])
                and row["contentRevision"] == raw["contentRevision"]
            ):
                completed[key] = row
        unfinished = {
            key
            for key, raw in native.items()
            if raw and (key not in versions or versions[key]["sequence"] < raw["generation"])
        }
        unfinished |= {
            row["documentId"] for row in snapshot["index_jobs"] if row["status"] == "pending"
        }
        return completed, unfinished

    def s717_settle(self, checkpoint, phase="s717-settled"):
        """Resume bounded work without replaying already completed current rows."""
        history, stable = [], {}
        previous = checkpoint["work_state"][0]["checkpoint"]
        previous_watermark = 0
        for batch in range(200):
            progress = self.s717_operation("update")
            current = self.snapshot("mailSidecar")
            self.assert_progress(progress, current)
            self.assertGreaterEqual(progress["acceptedThrough"], previous)
            self.assertGreaterEqual(progress["sourceWatermark"], progress["acceptedThrough"])
            self.assertGreaterEqual(progress["sourceWatermark"], previous_watermark)
            previous_watermark = progress["sourceWatermark"]
            previous = progress["acceptedThrough"]
            identity = self.s717_identity()
            completed, unfinished = self.s717_completed(current, identity, progress)
            versions = {row["documentId"]: row for row in current["document_versions"]}
            documents = {row["documentId"]: row for row in current["documents"]}
            for key, (row, version) in stable.items():
                self.assertEqual(
                    documents[key], row, "Completed current content must not be replayed"
                )
                self.assertEqual(versions[key], version)
            stable.update({key: (row, versions[key]) for key, row in completed.items()})
            history.append(progress)
            if not progress["pending"] and not progress["rebuilding"] and not progress["moreWork"]:
                self.record(phase, {"progress": history, "mail": current, "identity": identity})
                self.assertFalse(unfinished)
                self.assertEqual(progress["acceptedThrough"], progress["sourceWatermark"])
                self.assertEqual(
                    progress["unavailable"],
                    3,
                    "Validated eligible recovered bodies stay available",
                )
                return {"progress": history, "mail": current, "identity": identity}
        self.record(phase + "-unsettled", history)
        self.fail("S717 fixed corpus did not settle within 200 bounded batches")

    def assert_s717_corpus(self, result, baseline):
        """Require suppression, current physical tokens and byte-exact recovery."""
        f, c = self.fixture, self.fixture["s717"]
        roles = {row["role"]: row for row in self.s717_data["mail"]}
        by_id = {row["id"]: row for row in result["rows"]}
        self.assertIsNone(by_id[roles["deleted"]["id"]]["raw"])
        self.assertIsNone(by_id[roles["deleted"]["id"]]["text"])
        excluded = by_id[roles["excluded"]["id"]]
        self.assertIs(
            excluded["state"]["eligible"], False, "Dedicated excluded target is ineligible"
        )
        self.assertIsNone(excluded["text"], "Dedicated excluded body is never deliverable")
        self.assertEqual(
            by_id[roles["edit"]["id"]]["text"]["subject"], c["mail"]["edit"]["newSubject"]
        )
        self.assertEqual(by_id[f["recovered"]["id"]]["text"]["body"], f["recovered"]["body"])
        self.assertEqual(by_id[f["recovered"]["emptyId"]]["text"]["body"], "")
        for row in result["rows"]:
            text, raw = row["text"], row["raw"]
            if text is not None:
                self.assertEqual(text["id"], row["id"])
                self.assertEqual(text["generation"], raw["generation"])
                self.assertEqual(text["contentRevision"], raw["contentRevision"])
                self.assertEqual(text["policyRevision"], int(raw["policyRevision"]))
                self.assertEqual(
                    row["state"]["location"],
                    {"messageKey": int(row["id"]), "folderId": row["folderId"]},
                )
        expected = {
            "s717newsubject": {roles["edit"]["id"]},
            "s717editbody": {roles["edit"]["id"]},
            "s717selectedbody": {roles["open"]["id"], roles["other"]["id"]},
            "recovered": {f["recovered"]["id"]},
        }
        for term, hits in result["mailQueries"].items():
            self.assertEqual({hit["id"] for hit in hits}, expected.get(term, set()), term)
            self.assertEqual(len(hits), len(expected.get(term, set())), term)
            for hit in hits:
                for field in ("generation", "contentRevision", "policyRevision", "textRevision"):
                    self.assertEqual(hit[field], by_id[hit["id"]]["text"][field])
        self.assertEqual(
            result["recovered"],
            baseline["mailRecovery"],
            "Original receipt/import/source provenance is unchanged",
        )
        self.assertEqual(result["chatRecovery"], baseline["chatRecovery"])
        self.assertEqual(result["originalChat"]["body"], f["chat"]["expectedBody"])
        self.assertEqual(
            result["originalChat"]["contentRevision"], self.digest(Path(f["chat"]["path"]))
        )
        selected, peer = self.s717_data["logs"]
        body = (
            c["chat"]["speaker"]
            + ": "
            + c["chat"]["keep"]["text"]
            + "\n\n"
            + c["chat"]["speaker"]
            + ": "
            + c["chat"]["edit"]["newText"]
        )
        for row in result["chatTexts"]:
            expected_body = (
                body
                if row["role"] == "selected"
                else c["chat"]["speaker"] + ": " + c["chat"]["otherPhysical"]
            )
            for field in ("text", "sharedText"):
                self.assertIsNotNone(row[field])
                self.assertEqual(row[field]["id"], row["id"])
                self.assertEqual(row[field]["body"], expected_body)
                self.assertEqual(row[field]["contentRevision"], self.digest(Path(row["path"])))
            for role in ("deleted", "noLog", "redacted"):
                self.assertNotIn(c["chat"][role]["text"], row["raw"])
        for term, queries in result["chatQueries"].items():
            ids = (
                {selected["id"]} if term in ("s717chatnewneedle", "s717chatkeepneedle") else set()
            )
            if term == c["chat"]["otherPhysical"]:
                ids = {peer["id"]}
            for kind, hits in queries.items():
                self.assertEqual(
                    {(hit["hit"] if kind == "shared" else hit)["id"] for hit in hits}, ids, term
                )
                self.assertEqual(len(hits), len(ids))
                for item in hits:
                    hit = item["hit"] if kind == "shared" else item
                    text = next(
                        row["sharedText" if kind == "shared" else "text"]
                        for row in result["chatTexts"]
                        if row["id"] == hit["id"]
                    )
                    for field in (
                        "generation",
                        "contentRevision",
                        "policyRevision",
                        "textRevision",
                    ):
                        self.assertEqual(hit[field], text[field])
                    if kind == "shared":
                        self.assertEqual(item["document"], text)
                        self.assertIsInstance(item["snippet"]["text"], str)
        self.assertFalse(result["privacy"]["pending"])
        for role in ("deleted", "noLog", "redacted"):
            receipts = [
                row
                for row in result["privacy"]["completed"]
                if row["remoteId"] == c["chat"][role]["remoteId"]
            ]
            self.assertTrue(receipts, role)
            self.assertTrue(
                any(target["records"] for row in receipts for target in row["targets"])
            )
            for receipt in receipts:
                self.assertEqual(receipt["version"], 1)
                self.assertEqual(receipt["scope"]["account"], c["chat"]["account"])
                self.assertEqual(receipt["scope"]["conversation"], c["chat"]["conversation"])
                for target in receipt["targets"]:
                    self.assertEqual(target["relativePath"], json.loads(selected["id"][5:]))
                    self.assertEqual(len(target["headerSha256"]), 64)
                    for version in target["records"]:
                        self.assertGreater(version["line"], 0)
                        self.assertEqual(len(version["beforeSha256"]), 64)
                        self.assertEqual(len(version["erasedSha256"]), 64)

    def run_s717_policy_cancel_restart_query_open(self, baseline):
        """Append the whole destructive scenario before the unchanged outer cleanup."""
        self.s717_data = None
        try:
            inputs = self.s717_operation("inputs")
            self.s717_data = inputs["inputs"]
            self.record("s717-inputs", inputs)
            roles = {row["role"]: row for row in self.s717_data["mail"]}
            self.assertEqual(set(roles), {"edit", "deleted", "excluded", "open", "other"})
            self.assertEqual(len({row["id"] for row in roles.values()}), 5)
            history = []
            required = {roles[role]["id"] for role in ("edit", "deleted", "excluded")}
            for batch in range(200):
                progress = self.s717_operation("update")
                mail = self.snapshot("mailSidecar")
                self.assert_progress(progress, mail)
                identity = self.s717_identity()
                completed, unfinished = self.s717_completed(mail, identity, progress)
                history.append(progress)
                if (
                    required.issubset(completed)
                    and unfinished - set(completed)
                    and progress["moreWork"]
                ):
                    break
            else:
                self.record(
                    "s717-checkpoint-unsettled",
                    {"history": history, "mail": mail, "identity": identity},
                )
                self.fail(
                    "S717 requires accepted mutation targets and genuinely unfinished native work"
                )
            self.assertEqual(
                completed[self.fixture["recovered"]["id"]]["body"],
                self.fixture["recovered"]["body"],
            )
            self.record(
                "s717-checkpoint",
                {
                    "mail": mail,
                    "identity": identity,
                    "progress": history,
                    "completed": completed,
                    "unfinished": sorted(unfinished),
                },
            )
            mutations = self.s717_operation(
                "mutations", {"afterSequence": progress["acceptedThrough"]}
            )
            self.record("s717-mutations", mutations)
            self.assertIs(
                mutations["excluded"]["eligible"],
                False,
                "Dedicated excluded target must be ineligible after the real checkpoint",
            )
            self.assertIsNone(
                mutations["excluded"]["text"], "Dedicated excluded text must not be delivered"
            )
            self.assertIsNone(mutations["deletedText"])
            self.assertGreater(mutations["identity"]["watermark"], identity["watermark"])
            before_cancel = {
                "mail": self.snapshot("mailSidecar"),
                "chat": self.snapshot("chatSidecar"),
            }
            cancelled = self.s717_operation("cancel")
            cancelled["before"] = before_cancel
            cancelled["mail"] = self.snapshot("mailSidecar")
            cancelled["chat"] = self.snapshot("chatSidecar")
            self.record("s717-cancelled", cancelled)
            self.assertIs(cancelled["pendingAtAbort"], True)
            self.assertIs(cancelled["cancellation"]["sameReason"], True)
            self.assertIs(cancelled["queued"], True)
            self.assertIs(cancelled["readResult"]["sameReason"], True)
            self.assertLess(
                cancelled["mail"]["work_state"][0]["checkpoint"],
                cancelled["identity"]["watermark"],
            )
            closed = self.s717_operation("before-restart")
            closed["mail"] = self.snapshot("mailSidecar")
            closed["chat"] = self.snapshot("chatSidecar")
            self.record("s717-before-restart", closed)
            self.assertEqual(closed["mail"], cancelled["mail"])
            self.assertEqual(closed["chat"], cancelled["chat"])
            shutdown = self.stop()
            self.assertEqual(self.snapshot("mailSidecar"), closed["mail"])
            self.assertEqual(self.snapshot("chatSidecar"), closed["chat"])
            after = self.s717_start(closed["identity"])
            self.assertEqual(self.snapshot("mailSidecar"), closed["mail"])
            self.assertEqual(self.snapshot("chatSidecar"), closed["chat"])
            privacy = self.s717_operation("privacy")
            self.record(
                "s717-resumed-before-advance",
                {
                    "before": closed,
                    "after": after,
                    "shutdown": shutdown,
                    "privacy": privacy,
                },
            )
            for field in ("pending", "completed"):
                self.assertEqual(
                    privacy[field],
                    closed["privacy"][field],
                    "Durable scoped exclusions survive restart",
                )
            self.assert_source_hashes()
            self.assert_receipt_keys()
            self.s717_settle(closed["mail"])
            corpus = self.s717_operation("corpus")
            self.record("s717-settled-corpus", corpus)
            self.assert_s717_corpus(corpus, baseline)
            opened = self.s717_operation("mail-open")
            self.record("s717-mail-open", opened)
            self.assertEqual(opened["sourceId"], self.fixture["sourceId"])
            self.assertEqual(opened["key"], int(roles["open"]["id"]))
            self.assertEqual(opened["folderURI"], roles["open"]["folderURI"])
            self.assertIn(self.fixture["s717"]["mail"]["open"]["body"], opened["displayed"])
            chat_open = self.s717_operation("chat-open")
            self.record("s717-chat-open", chat_open)
            self.assertEqual(chat_open["id"], self.s717_data["logs"][0]["id"])
            self.assertNotEqual(chat_open["sharedSidecar"], chat_open["dedicatedSidecar"])
            self.assertIn(self.fixture["s717"]["chat"]["keep"]["text"], chat_open["displayed"])
            self.s717_operation("projection")
            projection = self.s717_settle(self.snapshot("mailSidecar"), "s717-projection-settled")
            final = self.s717_operation("corpus")
            self.record("s717-final", {"projection": projection, "corpus": final})
            self.assert_s717_corpus(final, baseline)
            self.assert_source_hashes()
            self.assert_receipt_keys()
            self.assertEqual(self.digest(Path(self.fixture["journalPath"])), self.journal_hash)
        finally:
            if not self.marionette.session:
                self.marionette.start_session(capabilities=self.capabilities)
                self.marionette.set_context(self.marionette.CONTEXT_CHROME)
                self.s717_operation("reopen", self.s717_data)
            cleanup = self.s717_operation("cleanup")
            self.record("s717-cleanup", cleanup)
            self.assertEqual(cleanup["errors"], [])
            self.assertEqual(cleanup["pendingWaits"], 0)

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
