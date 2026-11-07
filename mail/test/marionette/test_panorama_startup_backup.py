# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import hashlib
import json
import shutil
import tempfile
import uuid
from pathlib import Path

from marionette_harness import MarionetteTestCase


class TestPanoramaStartupBackup(MarionetteTestCase):
    """Copy the real stopped profile at ordinary comm app-startup."""

    def setUp(self):
        super().setUp()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.profile = Path(self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )).resolve()
        self.original_args = list(self.marionette.instance.app_args or [])
        self.instance_prefs = self.marionette.instance.prefs
        self.saved_prefs = {}
        self.work = tempfile.TemporaryDirectory(prefix="comm-startup-copy-")
        self.root = Path(self.work.name).resolve()
        self.addCleanup(self.work.cleanup)
        self.source = self.profile / ("startup-copy-" + uuid.uuid4().hex)
        self.source.write_bytes(b"Original profile message bytes.\n")
        self.changed_prefs = {}

    def set_pref(self, name, value):
        """Save each original user value before persisting a test preference."""
        if name not in self.saved_prefs:
            self.saved_prefs[name] = (
                self.marionette.execute_script(
                    "return Services.prefs.prefHasUserValue(arguments[0]);",
                    script_args=[name],
                ),
                self.marionette.get_pref(name),
            )
        self.marionette.set_pref(name, value)
        self.changed_prefs[name] = value

    def stop(self):
        """Close ordinary application writers through the normal test runner."""
        self.marionette.execute_script("Services.prefs.savePrefFile(null);")
        self.marionette.quit(in_app=True)

    def start(self, extra_args=None):
        """Start the same profile with the normal runner and selected flags."""
        self.marionette.instance.app_args = self.original_args + (extra_args or [])
        self.marionette.instance.prefs = {
            **(self.instance_prefs or {}), **self.changed_prefs
        }
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        selected = self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )
        self.assertEqual(self.profile, Path(selected).resolve())
        self.assertEqual("mail:3pane", self.marionette.get_window_type())

    def startup_code(self):
        """Read the existing recorder's actual profile-do-change observation."""
        return self.marionette.execute_script("""
            const recorder = Cc['@mozilla.org/test/startuprecorder;1']
                .getService(Ci.nsIObserver).wrappedJSObject;
            return recorder.data.code['before profile selection'];
        """)

    def tearDown(self):
        try:
            if not self.marionette.session:
                self.marionette.instance.app_args = self.original_args
                self.marionette.start_session()
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            for name, (user, value) in self.saved_prefs.items():
                if user:
                    self.marionette.set_pref(name, value)
                else:
                    self.marionette.clear_pref(name)
            self.marionette.execute_script("Services.prefs.savePrefFile(null);")
            self.marionette.quit(in_app=True)
            self.source.unlink(missing_ok=True)
            self.marionette.instance.app_args = self.original_args
            self.marionette.instance.prefs = self.instance_prefs
            self.marionette.start_session()
        finally:
            super().tearDown()

    def test_before_writers_default_and_failed_copy(self):
        """Verify the actual copy, startup phase, defaults and input rejection."""
        self.set_pref("browser.startup.record", True)
        self.set_pref("mailnews.database.global.indexer.enabled", False)
        self.set_pref("offline.startup_state", 2)
        key = "s508" + uuid.uuid4().hex
        mbox = self.root / "mbox"
        maildir = self.root / "maildir"
        mbox.mkdir()
        (maildir / "Inbox" / "cur").mkdir(parents=True)
        (mbox / "Inbox").write_bytes(b"From sender\nSubject: mbox\n\nBody.\n")
        body = maildir / "Inbox" / "cur" / "message"
        body.write_bytes(bytes(range(256)) * 4097)
        self.set_pref(f"mail.server.{key}box.directory", str(mbox))
        self.set_pref(f"mail.server.{key}box.type", "imap")
        self.set_pref(f"mail.server.{key}dir.directory", str(self.root / "wrong"))
        relative = self.marionette.execute_script("""
            const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
            file.initWithPath(arguments[0]);
            return '[ProfD]' + file.getRelativeDescriptor(
                Services.dirsvc.get('ProfD', Ci.nsIFile));
        """, script_args=[str(maildir)])
        self.set_pref(f"mail.server.{key}dir.directory-rel", relative)
        self.set_pref(f"mail.server.{key}dir.type", "imap")
        expected = {
            self.source: hashlib.sha256(self.source.read_bytes()).hexdigest(),
            mbox / "Inbox": hashlib.sha256((mbox / "Inbox").read_bytes()).hexdigest(),
            body: hashlib.sha256(body.read_bytes()).hexdigest(),
        }
        self.stop()
        # These are ordinary closed-profile files, not a synthetic NSS facade.
        nss = {name: (self.profile / name).read_bytes()
               for name in ("cert9.db", "key4.db", "pkcs11.txt")
               if (self.profile / name).exists()}
        backup = self.root / "backup"
        self.start(["--panorama-backup", str(backup)])
        manifest_path = backup / "manifest.json"
        self.assertTrue(
            manifest_path.exists(),
            "Opt-in startup must publish its backup before normal writers start",
        )
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertIs(manifest["complete"], True)
        for source, digest in expected.items():
            root = next(item for item in manifest["roots"]
                        if source.is_relative_to(Path(item["source"]).resolve()))
            copy = backup / root["directory"] / source.relative_to(Path(root["source"]).resolve())
            self.assertEqual(digest, hashlib.sha256(copy.read_bytes()).hexdigest())
        profile_root = next(item for item in manifest["roots"]
                            if Path(item["source"]).resolve() == self.profile)
        for name, before in nss.items():
            self.assertEqual(before, (backup / profile_root["directory"] / name).read_bytes())
        code = self.startup_code()
        self.assertIn("resource:///modules/panorama/MigrationBackup.sys.mjs", code["modules"])
        self.assertNotIn("@mozilla.org/messenger/account-manager;1", code["services"])
        self.assertNotIn("@mozilla.org/msgDatabase/msgDBService;1", code["services"])
        for module in (
            "resource:///modules/logger.sys.mjs",
            "resource:///modules/gloda/GlodaPublic.sys.mjs",
            "resource:///modules/panorama/MailSearch.sys.mjs",
            "resource:///modules/panorama/ChatSearchService.sys.mjs",
        ):
            self.assertNotIn(module, code["modules"])
        verified = self.marionette.execute_async_script("""
            const done = arguments[arguments.length - 1];
            const { verifyMigrationBackup } = ChromeUtils.importESModule(
                'resource:///modules/panorama/MigrationBackup.sys.mjs');
            verifyMigrationBackup(arguments[0]).then(done, e => done({error: String(e)}));
        """, script_args=[str(backup)])
        self.assertNotIn("error", verified)
        self.assertEqual(hashlib.sha256(manifest_bytes).hexdigest(), verified["sha256"])

        self.stop()
        body.write_bytes(b"Normal later source write.\n")
        self.start()
        self.assertEqual(manifest_bytes, manifest_path.read_bytes())
        self.assertNotIn("resource:///modules/panorama/MigrationBackup.sys.mjs",
                         self.startup_code()["modules"])
        self.stop()
        unsafe = self.profile / ("unsafe-backup-" + uuid.uuid4().hex)
        self.start(["--panorama-backup", str(unsafe)])
        self.assertFalse(unsafe.exists(), "Unsafe copy must not publish even an incomplete archive")
        self.assertEqual(b"Normal later source write.\n", body.read_bytes())
        self.assertEqual(manifest_bytes, manifest_path.read_bytes())

    def tree_snapshot(self, root):
        """Independently read every directory and file byte in a physical tree."""
        entries = {}
        for path in sorted(root.rglob("*")):
            self.assertFalse(path.is_symlink(), "Restore trees must not contain links")
            relative = path.relative_to(root).as_posix()
            if path.is_dir():
                entries[relative] = {"type": "directory"}
            else:
                self.assertTrue(path.is_file(), "Restore entries must be regular files")
                data = path.read_bytes()
                entries[relative] = {
                    "type": "regular",
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
        return entries

    def stage_restore(self, backup, parent):
        """Call the existing restore API and return its actual result or error."""
        return self.marionette.execute_async_script("""
            const done = arguments[arguments.length - 1];
            const { stageMigrationRestore } = ChromeUtils.importESModule(
                'resource:///modules/panorama/MigrationBackup.sys.mjs');
            stageMigrationRestore(arguments[0], arguments[1])
                .then(done, error => done({ error: String(error) }));
        """, script_args=[str(backup), str(parent)])

    def staged_metadata(self, path, root):
        """Read restored modes and times with the platform's native file API."""
        return self.marionette.execute_script("""
            const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
            file.initWithPath(arguments[0]);
            const entries = [{ parts: [] }, ...arguments[1].entries];
            return Object.fromEntries(entries.map(entry => {
                const child = file.clone();
                for (const part of entry.parts) {
                    child.append(part);
                }
                return [entry.parts.join('/'), {
                    permissions: child.permissions,
                    lastModified: child.lastModifiedTime,
                }];
            }));
        """, script_args=[str(path), root])

    def test_completeBackupAndIndependentRestore(self):
        """Restore every real profile/store entry without changing the originals."""
        self.set_pref("mailnews.database.global.indexer.enabled", False)
        self.set_pref("offline.startup_state", 2)
        key = "s510" + uuid.uuid4().hex
        mbox = self.root / "mbox"
        maildir = self.root / "maildir"
        mbox.mkdir()
        for name in ("cur", "new", "tmp"):
            (maildir / "Inbox" / name).mkdir(parents=True)
        (mbox / "Inbox").write_bytes(b"From backup\nSubject: mbox\n\nExact bytes.\n")
        body = maildir / "Inbox" / "cur" / "message"
        body.write_bytes(bytes(range(256)) * 4097)
        (maildir / "zero-length").write_bytes(b"")
        self.set_pref(f"mail.server.{key}box.directory", str(mbox))
        self.set_pref(f"mail.server.{key}box.type", "imap")
        self.set_pref(f"mail.server.{key}dir.directory", str(maildir))
        self.set_pref(f"mail.server.{key}dir.type", "imap")
        expected = {
            self.source: self.source.read_bytes(),
            mbox / "Inbox": (mbox / "Inbox").read_bytes(),
            body: body.read_bytes(),
        }
        self.stop()
        nss = {
            name: (self.profile / name).read_bytes()
            for name in ("cert9.db", "key4.db", "pkcs11.txt")
            if (self.profile / name).exists()
        }
        external_before = {
            root.resolve(): self.tree_snapshot(root) for root in (mbox, maildir)
        }
        backup = self.root / "complete-backup"
        self.start(["--panorama-backup", str(backup)])
        manifest_path = backup / "manifest.json"
        self.assertTrue(manifest_path.exists(), "Startup must publish the full backup")
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertIs(manifest["complete"], True)
        roots = {Path(root["source"]).resolve(): root for root in manifest["roots"]}
        self.assertEqual({self.profile, mbox.resolve(), maildir.resolve()}, set(roots))
        self.assertEqual(len(manifest["roots"]), len(roots))
        archive = {
            original: self.tree_snapshot(backup / root["directory"])
            for original, root in roots.items()
        }
        for original, root in roots.items():
            declared = {}
            for entry in root["entries"]:
                value = {"type": entry["type"]}
                if entry["type"] == "regular":
                    value.update(size=entry["size"], sha256=entry["sha256"])
                declared["/".join(entry["parts"])] = value
            self.assertEqual(declared, archive[original], "Full archive inventory must match")
        for source, value in expected.items():
            root = next(root for root in roots.values()
                        if source.is_relative_to(Path(root["source"]).resolve()))
            copied = backup / root["directory"] / source.relative_to(Path(root["source"]).resolve())
            self.assertEqual(value, copied.read_bytes(), "Stopped source bytes must survive")
        profile_root = roots[self.profile]
        for name, value in nss.items():
            self.assertEqual(value, (backup / profile_root["directory"] / name).read_bytes())
        for original, snapshot in external_before.items():
            self.assertEqual(snapshot, archive[original])

        parent = self.root / "restore-parent"
        parent.mkdir()
        restored = self.stage_restore(backup, parent)
        self.assertNotIn("error", restored, restored)
        restore_path = Path(restored["path"]).resolve()
        self.assertEqual(parent, restore_path.parent)
        restored_roots = {Path(item["original"]).resolve(): Path(item["staged"]).resolve()
                          for item in restored["roots"]}
        self.assertEqual(set(roots), set(restored_roots))
        self.assertEqual(len(roots), len(restored["roots"]))
        # Read the real staged trees with independent Python I/O.
        for original, target in restored_roots.items():
            self.assertTrue(target.is_relative_to(restore_path))
            self.assertEqual(
                archive[original], self.tree_snapshot(target),
                "Restored tree must match independent complete archive inventory",
            )
            root = roots[original]
            metadata = {"": {name: root[name]
                             for name in ("permissions", "lastModified")}}
            metadata.update({
                "/".join(entry["parts"]): {name: entry[name]
                                         for name in ("permissions", "lastModified")}
                for entry in root["entries"]
            })
            self.assertEqual(metadata, self.staged_metadata(target, root))

        sentinel = restored_roots[self.profile] / "restored-only-marker"
        sentinel.write_bytes(b"Do not overwrite an earlier staged restore.\n")
        second = self.stage_restore(backup, parent)
        self.assertNotIn("error", second, second)
        self.assertNotEqual(restore_path, Path(second["path"]).resolve())
        self.assertEqual(b"Do not overwrite an earlier staged restore.\n", sentinel.read_bytes())
        for item in second["roots"]:
            self.assertEqual(archive[Path(item["original"]).resolve()],
                             self.tree_snapshot(Path(item["staged"]).resolve()))

        corrupt = self.root / "corrupt-backup"
        shutil.copytree(backup, corrupt)
        (corrupt / profile_root["directory"] / self.source.name).write_bytes(b"corrupt")
        before_refusal = set(parent.iterdir())
        refused = self.stage_restore(corrupt, parent)
        self.assertIn("error", refused)
        self.assertIn("Migration backup file differs from its source", refused["error"])
        self.assertEqual(before_refusal, set(parent.iterdir()),
                         "Verification failure must not create restore staging")
        self.assertEqual(manifest_bytes, manifest_path.read_bytes())
        for original, root in roots.items():
            self.assertEqual(archive[original], self.tree_snapshot(backup / root["directory"]))
        for original, snapshot in external_before.items():
            self.assertEqual(snapshot, self.tree_snapshot(Path(original)))
        self.assertEqual(expected[self.source], self.source.read_bytes())



class TestPanoramaStartupActivation(MarionetteTestCase):
    """Exercise the real XRE/ordinary command/profile lifecycle on Linux."""

    def setUp(self):
        super().setUp()
        self.original_prefs = self.marionette.instance.prefs
        self.original_args = list(self.marionette.instance.app_args or [])
        self.created_work = set()
        self.profile = None

    def stop_application(self):
        """Settle ordinary writers and release the real process profile lock."""
        if self.marionette.session:
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.marionette.execute_script("Services.prefs.savePrefFile(null);")
            self.marionette.quit(in_app=True)

    def clean_profile(self, enabled):
        """Use the ordinary runner after a normal quit, with a fresh profile."""
        self.stop_application()
        self.marionette.instance.restart(
            prefs={**(self.original_prefs or {}), "mail.panorama.enabled": enabled},
            clean=True,
        )
        self.marionette.raise_for_port(timeout=self.marionette.startup_timeout)
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.profile = Path(self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )).resolve()
        self.assertEqual("mail:3pane", self.marionette.get_window_type())

    def start_same_profile(self, enabled):
        """Start the same stopped profile through its original normal runner."""
        self.marionette.instance.prefs = {
            **(self.original_prefs or {}), "mail.panorama.enabled": enabled
        }
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        selected = self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )
        self.assertEqual(self.profile, Path(selected).resolve())
        self.assertEqual("mail:3pane", self.marionette.get_window_type())

    def selection(self):
        """Read actual durable backend/native identities after ordinary startup."""
        result = self.marionette.execute_async_script("""
            const done = arguments[arguments.length - 1];
            (async () => {
              const { MailGlue } = ChromeUtils.importESModule(
                'resource:///modules/MailGlue.sys.mjs');
              await MailGlue.panoramaStartup;
              const profile = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
              const record = await IOUtils.readJSON(
                PathUtils.join(profile, 'panorama-profile.json'));
              const core = Cc['@mozilla.org/mailnews/database-core;1']
                .getService(Ci.nsIDatabaseCore);
              return {record, sourceId: core.sourceId};
            })().then(done, error => done({error: String(error)}));
        """)
        self.assertNotIn("error", result)
        record = result["record"]
        self.assertEqual(2, record["formatVersion"])
        self.assertEqual("active", record["state"])
        self.assertEqual("panorama", record["backend"])
        self.assertEqual(result["sourceId"], record["identity"]["databaseSourceId"])
        self.assertTrue(result["sourceId"])
        if record["identity"]["backup"]:
            self.created_work.add(Path(record["identity"]["backup"]["path"]).parent.parent)
        return result

    def create_legacy_message(self, store):
        """Write genuine Mork/store data through the normal legacy mail API."""
        result = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            const root = PathUtils.join(PathUtils.profileDir, 'Mail',
              's526-' + Services.uuid.generateUUID().toString());
            const file = new FileUtils.File(root);
            if (!file.parent.exists()) {
              file.parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            }
            file.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            const server = MailServices.accounts.createIncomingServer(
              's526', 'localhost', 'none');
            server.setStringValue('storeContractID', arguments[0] === 'maildir'
              ? '@mozilla.org/msgstore/maildirstore;1'
              : '@mozilla.org/msgstore/berkeleystore;1');
            server.localPath = file;
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const parent = server.rootFolder;
            parent.createSubfolder('Inbox', null);
            const folder = parent.getChildNamed('Inbox')
              .QueryInterface(Ci.nsIMsgLocalMailFolder);
            const header = folder.addMessage(
              'From - Thu Nov 05 00:00:00 2026\r\n' +
              'Message-ID: <activation-s526@invalid>\r\n' +
              'From: source@example.invalid\r\n' +
              'To: destination@example.invalid\r\n' +
              'Subject: Original startup migration\r\n' +
              'Date: Thu, 5 Nov 2026 00:00:00 +0000\r\n\r\n' +
              'Preserved message body.\r\n');
            header.setStringProperty('s526-custom', 'retained');
            folder.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root, summary: folder.summaryFile.path,
              key: header.messageKey, store: folder.msgStore.storeType};
        """, script_args=[store])
        self.assertEqual(store, result["store"])
        return result

    def assert_message_after_activation(self, source):
        """Read the imported message through the ordinary native folder/header API."""
        result = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const server = MailServices.accounts.getIncomingServer(arguments[0]);
            const folder = server.rootFolder.getChildNamed('Inbox');
            return [...folder.msgDatabase.enumerateMessages()].map(header => ({
              messageId: header.messageId,
              subject: header.subject,
              property: header.getStringProperty('s526-custom'),
              key: header.messageKey,
            }));
        """, script_args=[source["serverKey"]])
        self.assertEqual(1, len(result))
        self.assertEqual("activation-s526@invalid", result[0]["messageId"])
        self.assertEqual("Original startup migration", result[0]["subject"])
        self.assertEqual("retained", result[0]["property"])
        return result

    def assert_mork_migration(self, store):
        """Migrate genuine legacy data, then prove identity-preserving reuse."""
        self.clean_profile(False)
        source = self.create_legacy_message(store)
        self.stop_application()
        source_root = Path(source["root"])
        before = {path: path.read_bytes() for path in source_root.rglob("*") if path.is_file()}
        self.assertIn(Path(source["summary"]), before)
        self.assertFalse((self.profile / "panorama.sqlite").exists())
        self.start_same_profile(True)
        selected = self.selection()
        record = selected["record"]
        self.assertEqual("migrated", record["origin"])
        self.assertTrue(record["identity"]["imports"])
        headers = self.assert_message_after_activation(source)
        backup = Path(record["identity"]["backup"]["path"])
        manifest = json.loads(backup.read_text())
        self.assertTrue(manifest["complete"])
        self.assertEqual(self.profile, Path(manifest["roots"][0]["source"]))
        for path, original in before.items():
            self.assertEqual(original, path.read_bytes())
            archived = backup.parent / "root-0" / path.relative_to(self.profile)
            self.assertEqual(original, archived.read_bytes())
        self.stop_application()
        selector = (self.profile / "panorama-profile.json").read_bytes()
        journal_path = Path(record["identity"]["journalPath"])
        journal = journal_path.read_bytes()
        self.assertEqual("complete", json.loads(journal)["stage"])
        # Old Mork is deliberately stale now; the native database must win.
        Path(source["summary"]).write_bytes(b"stale legacy Mork must not be imported\n")
        self.start_same_profile(True)
        repeated = self.selection()
        self.assertEqual(selected["sourceId"], repeated["sourceId"])
        self.assertEqual(headers, self.assert_message_after_activation(source))
        self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
        self.assertEqual(journal, journal_path.read_bytes())
        self.assertEqual(before[Path(source["summary"])],
                         (backup.parent / "root-0" / Path(source["summary"]).relative_to(self.profile)).read_bytes())

    def test_empty_profile_initialization_and_repeated_reuse(self):
        self.clean_profile(True)
        selected = self.selection()
        self.assertEqual("initialized-empty", selected["record"]["origin"])
        self.assertIsNone(selected["record"]["identity"]["backup"])
        self.assertIsNone(selected["record"]["identity"]["journalPath"])
        self.assertEqual([], selected["record"]["identity"]["imports"])
        self.stop_application()
        before = (self.profile / "panorama-profile.json").read_bytes()
        stale = self.profile / "stale.mab"
        stale.write_bytes(b"unrelated stale Mork must not be imported\n")
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(before, (self.profile / "panorama-profile.json").read_bytes())
        self.assertEqual(b"unrelated stale Mork must not be imported\n", stale.read_bytes())

    def test_genuine_mork_mbox_migration_and_reuse(self):
        self.assert_mork_migration("mbox")

    def test_genuine_mork_maildir_migration_and_reuse(self):
        self.assert_mork_migration("maildir")

    def test_existing_native_database_without_selector_is_adopted_before_mork(self):
        """A valid existing native source wins even without a selection record."""
        self.clean_profile(True)
        selected = self.selection()
        source = self.create_legacy_message("mbox")
        headers = self.assert_message_after_activation(source)
        self.stop_application()
        selector = self.profile / "panorama-profile.json"
        saved = self.profile / "saved-original-selector.json"
        original = selector.read_bytes()
        selector.replace(saved)
        stale = self.profile / "unrelated-old.mab"
        stale.write_bytes(b"Invalid stale Mork must not replace native data.\n")
        self.start_same_profile(True)
        adopted = self.selection()
        self.assertEqual("adopted-existing", adopted["record"]["origin"])
        self.assertEqual(selected["sourceId"], adopted["sourceId"])
        self.assertEqual(headers, self.assert_message_after_activation(source))
        self.assertEqual(original, saved.read_bytes())
        self.assertIsNone(adopted["record"]["identity"]["backup"])
        self.assertIsNone(adopted["record"]["identity"]["journalPath"])
        self.stop_application()
        before = selector.read_bytes()
        self.start_same_profile(True)
        self.assertEqual(adopted["sourceId"], self.selection()["sourceId"])
        self.assertEqual(before, selector.read_bytes())

    def test_unsafe_external_store_refuses_before_target_creation(self):
        """An unowned external writer root is never an empty-profile input."""
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        external = tempfile.TemporaryDirectory(prefix="s526-external-")
        self.addCleanup(external.cleanup)
        path = Path(external.name).resolve()
        data = path / "retained-source"
        data.write_bytes(b"External writer source stays owned by its caller.\n")
        self.marionette.execute_script("""
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            Services.prefs.clearUserPref('mail.server.' + arguments[0] + '.directory-rel');
            Services.prefs.setComplexValue('mail.server.' + arguments[0] + '.directory',
              Ci.nsIFile, new FileUtils.File(arguments[1]));
            Services.prefs.savePrefFile(null);
        """, script_args=[source["serverKey"], str(path)])
        self.stop_application()
        self.assert_startup_refuses(
            [data, Path(source["summary"])],
            absent=[self.profile / "panorama.sqlite", self.profile / "panorama-profile.json"],
        )
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        self.assertFalse(work.exists(), "Refusal precedes even backup/target work")

    def test_legacy_default_does_not_create_panorama(self):
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        self.stop_application()
        summary = Path(source["summary"]).read_bytes()
        self.start_same_profile(False)
        self.assertFalse(self.marionette.get_pref("mail.panorama.enabled"))
        self.assertFalse((self.profile / "panorama.sqlite").exists())
        self.assertFalse((self.profile / "panorama-profile.json").exists())
        self.assertEqual(summary, Path(source["summary"]).read_bytes())
        self.assertEqual("activation-s526@invalid",
                         self.assert_message_after_activation(source)[0]["messageId"])

    def test_native_downgrade_and_backend_fallback_refuse(self):
        self.clean_profile(True)
        selected = self.selection()
        self.stop_application()
        selector_path = self.profile / "panorama-profile.json"
        original = selector_path.read_bytes()
        database_path = self.profile / "panorama.sqlite"
        original_database = database_path.read_bytes()
        current = selected["record"]
        # Use the actual running build/version; only the durable reader floor changes.
        future = dict(current["application"])
        future["buildId"] = str(int(future["buildId"][:4]) + 1) + future["buildId"][4:]
        future_version = {**current["application"], "version": "9999.0"}
        for changed, enabled in [
            (future_version, True),
            (future, True),
            (current["application"], False),
        ]:
            record = json.loads(original)
            record["application"] = changed
            selector_path.write_text(json.dumps(record))
            before = selector_path.read_bytes()
            self.marionette.instance.prefs = {
                **(self.original_prefs or {}), "mail.panorama.enabled": enabled
            }
            self.marionette.instance.start()
            returncode = self.marionette.instance.runner.wait(
                timeout=self.marionette.startup_timeout
            )
            self.assertEqual(5, returncode,
                             "The native failure must exit with NS_ERROR_FAILURE")
            self.assertEqual(before, selector_path.read_bytes())
            self.assertEqual(original_database, database_path.read_bytes())
            selector_path.write_bytes(original)
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.stop_application()
            original_database = database_path.read_bytes()

    def assert_startup_refuses(self, files, absent=()):
        """Require an actual stopped application and exact recovery preservation."""
        before = {path: path.read_bytes() for path in files}
        self.marionette.instance.prefs = {
            **(self.original_prefs or {}), "mail.panorama.enabled": True
        }
        # Observe the ordinary failed process before session auto-cleanup can
        # remove its disposable profile; inspect the same original files below.
        self.marionette.instance.start()
        returncode = self.marionette.instance.runner.wait(
            timeout=self.marionette.startup_timeout
        )
        self.assertEqual(5, returncode,
                         "Recovery must exit with NS_ERROR_FAILURE, not hang")
        for path, contents in before.items():
            self.assertEqual(contents, path.read_bytes())
        for path in absent:
            self.assertFalse(path.exists(), "Recovery must not create " + str(path))

    def test_corrupt_prepared_and_interrupted_states_are_never_absence(self):
        self.clean_profile(True)
        selected = self.selection()
        self.stop_application()
        selector = self.profile / "panorama-profile.json"
        database = self.profile / "panorama.sqlite"
        selector_bytes = selector.read_bytes()
        database_bytes = database.read_bytes()
        database.write_bytes(b"corrupt native database must not be recreated\n")
        self.assert_startup_refuses([selector, database])
        database.write_bytes(database_bytes)
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.stop_application()
        database_bytes = database.read_bytes()
        saved_database = self.profile / "saved-native-database.sqlite"
        database.replace(saved_database)
        record = json.loads(selector_bytes)
        record["state"] = "prepared"
        selector.write_text(json.dumps(record))
        self.assert_startup_refuses([selector, saved_database], absent=[database])
        selector.write_bytes(selector_bytes)
        saved_database.replace(database)
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.stop_application()
        database.replace(saved_database)
        saved_selector = self.profile / "saved-native-selector.json"
        selector.replace(saved_selector)
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        self.assertFalse(work.exists())
        work.mkdir(mode=0o700)
        self.created_work.add(work)
        journal = work / "journal.json"
        journal.write_bytes(b'{"interrupted":"retained journal requires recovery"}\n')
        self.assert_startup_refuses(
            [saved_selector, saved_database, journal], absent=[database, selector]
        )
        self.assertFalse((work / "backup").exists(),
                         "An existing journal cannot be hidden behind another backup")

    def tearDown(self):
        try:
            self.stop_application()
            self.marionette.instance.app_args = self.original_args
            self.marionette.instance.restart(prefs=self.original_prefs, clean=True)
            self.marionette.raise_for_port(timeout=self.marionette.startup_timeout)
            self.marionette.start_session()
            for work in self.created_work:
                # Remove only this disposable test's exact outside-profile archive.
                self.assertTrue(work.name.startswith("panorama-migration-"))
                shutil.rmtree(work)
        finally:
            super().tearDown()
