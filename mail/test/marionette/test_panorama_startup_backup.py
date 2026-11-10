# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import hashlib
import json
import os
import shutil
import signal
import sqlite3
import stat
import sys
import tempfile
import unittest
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
        self.panorama_enabled = self.marionette.get_pref("mail.panorama.enabled")
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

    def register_server(self, key):
        """List an account naming a persisted server, as the account manager does."""
        accounts = self.marionette.get_pref("mail.accountmanager.accounts") or ""
        self.set_pref("mail.account." + key + ".server", key)
        self.set_pref("mail.accountmanager.accounts",
                      ",".join(value for value in [accounts, key] if value))

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
        expected = self.changed_prefs.get("mail.panorama.enabled", self.panorama_enabled)
        self.assertEqual(expected, self.marionette.get_pref("mail.panorama.enabled"))
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
        self.register_server(f"{key}box")
        self.register_server(f"{key}dir")
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
        self.register_server(f"{key}box")
        self.register_server(f"{key}dir")
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

        # A restore nests the backed-up profile storage one level deeper than
        # the backup; keep its parent shallow so Windows paths stay valid.
        restore_work = tempfile.TemporaryDirectory(prefix="r")
        self.addCleanup(restore_work.cleanup)
        parent = Path(restore_work.name).resolve() / "p"
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
        self.registered_profiles = set()
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
            # Startup refusals quit before any window; log their recovery reason.
            prefs={**(self.original_prefs or {}), "mail.panorama.enabled": enabled,
                   "devtools.console.stdout.chrome": True},
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
        self.marionette.instance.profile.set_preferences({"mail.panorama.enabled": enabled})
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        selected = self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )
        self.assertEqual(self.profile, Path(selected).resolve())
        self.assertEqual(enabled, self.marionette.get_pref("mail.panorama.enabled"))
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

    def create_legacy_message(self, store, name="Inbox", user="s526", protocol="none",
                              root=None):
        """Write genuine Mork/store data through the normal legacy mail API.

        Local Folders, POP3 and RSS servers all keep local stores.
        """
        result = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            const root = arguments[4] || PathUtils.join(PathUtils.profileDir, 'Mail',
              's526-' + Services.uuid.generateUUID().toString());
            const file = new FileUtils.File(root);
            if (!file.parent.exists()) {
              file.parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            }
            file.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            const server = MailServices.accounts.createIncomingServer(
              arguments[2], 'localhost', arguments[3]);
            server.setStringValue('storeContractID', arguments[0] === 'maildir'
              ? '@mozilla.org/msgstore/maildirstore;1'
              : '@mozilla.org/msgstore/berkeleystore;1');
            server.localPath = file;
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const parent = server.rootFolder;
            // A POP3 account already created its default Inbox.
            if (!parent.containsChildNamed(arguments[1])) {
              parent.createSubfolder(arguments[1], null);
            }
            const folder = parent.getChildNamed(arguments[1])
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
              key: header.messageKey, store: folder.msgStore.storeType,
              name: folder.name, flags: folder.msgDatabase.dBFolderInfo.flags,
              protocol: server.type};
        """, script_args=[store, name, user, protocol, str(root) if root else None])
        self.assertEqual(store, result["store"])
        self.assertEqual(protocol, result["protocol"])
        return result

    def create_legacy_newsgroup(self, user="s526"):
        """Subscribe a genuine news server group and record one summary-only article."""
        result = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const server = MailServices.accounts.createIncomingServer(
              arguments[0], 'localhost', 'nntp');
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const news = server.QueryInterface(Ci.nsINntpIncomingServer);
            news.subscribeToNewsgroup('s526.migration');
            const folder = server.rootFolder.getChildNamed('s526.migration');
            const database = folder.msgDatabase;
            // An article whose body was never downloaded: metadata only.
            const header = database.createNewHdr(1);
            header.messageId = 'activation-s526@invalid';
            header.subject = 'Original startup migration';
            header.author = 'source@example.invalid';
            header.date = Date.UTC(2026, 10, 5) * 1000;
            header.setStringProperty('s526-custom', 'retained');
            database.addNewHdrToDB(header, true);
            database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            news.writeNewsrcFile();
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root: server.localPath.path,
              summary: folder.summaryFile.path, key: header.messageKey,
              store: folder.msgStore.storeType, name: folder.name,
              offline: folder.filePath.exists(), protocol: server.type};
        """, script_args=[user])
        self.assertEqual("nntp", result["protocol"])
        self.assertFalse(result["offline"], "No article body was downloaded")
        return result

    def assert_message_after_activation(self, source):
        """Read the imported message through the ordinary native folder/header API."""
        result = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const server = MailServices.accounts.getIncomingServer(arguments[0]);
            const folder = server.rootFolder.getChildNamed(arguments[1]);
            return [...folder.msgDatabase.enumerateMessages()].map(header => ({
              messageId: header.messageId,
              subject: header.subject,
              property: header.getStringProperty('s526-custom'),
              key: header.messageKey,
            }));
        """, script_args=[source["serverKey"], source["name"]])
        self.assertEqual(1, len(result))
        self.assertEqual("activation-s526@invalid", result[0]["messageId"])
        self.assertEqual("Original startup migration", result[0]["subject"])
        self.assertEqual("retained", result[0]["property"])
        return result

    def assert_mork_migration(self, store, protocol="none"):
        """Migrate genuine legacy data, then prove identity-preserving reuse."""
        self.clean_profile(False)
        source = (self.create_legacy_newsgroup() if protocol == "nntp"
                  else self.create_legacy_message(store, protocol=protocol))
        self.stop_application()
        # Compare physical paths: macOS reaches the runner profile through a
        # /var or /tmp link, and the server root keeps that spelling.
        source_root = Path(source["root"]).resolve()
        summary = Path(source["summary"]).resolve()
        before = {path: path.read_bytes() for path in source_root.rglob("*") if path.is_file()}
        self.assertIn(summary, before)
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
        stores = self.assert_index_backup(manifest, backup.parent, 0, before)
        self.assertEqual(protocol != "nntp", bool(stores),
                         "A local store is measured in place; news has none")
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
        self.assertEqual(before[summary],
                         (backup.parent / "root-0" / summary.relative_to(self.profile)).read_bytes())

        # Normal reuse consumes native data and durable identities, not the archive.
        self.stop_application()
        manifest_bytes = backup.read_bytes()
        backup.write_bytes(b"A damaged archive must not block active native reuse\n")
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(headers, self.assert_message_after_activation(source))
        self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
        self.assertEqual(journal, journal_path.read_bytes())
        self.stop_application()
        backup.write_bytes(manifest_bytes)
        moved_archive = backup.parent.with_name("retained-archive")
        backup.parent.replace(moved_archive)
        self.assertFalse(backup.parent.exists())
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(headers, self.assert_message_after_activation(source))
        self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
        self.assertEqual(journal, journal_path.read_bytes())
        self.assertFalse(backup.parent.exists(), "Reuse must not recreate the archive")
        self.assertEqual(manifest_bytes, (moved_archive / "manifest.json").read_bytes())

    def assert_index_backup(self, manifest, archive, index, before):
        """Index migration copies metadata; a message store is never read or copied."""
        self.assertEqual("index", manifest["scope"])
        root = manifest["roots"][index]
        base = Path(root["source"]).resolve()
        entries = {tuple(entry["parts"]): entry for entry in root["entries"]}
        stores = 0
        for path, original in before.items():
            self.assertEqual(original, path.read_bytes())
            entry = entries[path.relative_to(base).parts]
            archived = archive / root["directory"] / path.relative_to(base)
            if path.suffix == ".msf":
                self.assertEqual("regular", entry["type"])
            if entry["type"] == "in-place":
                stores += 1
                self.assertEqual(len(original), entry["size"])
                self.assertNotIn("sha256", entry)
                self.assertFalse(archived.exists(), "A message store is never copied")
            else:
                self.assertEqual(original, archived.read_bytes())
        copied = sum(path.stat().st_size for path in archive.rglob("*") if path.is_file())
        self.assertLess(copied, 16 * 1024 * 1024, "The archive stays near index size")
        return stores

    def register_selected_profile(self):
        """Register the actual current path; XRE resolves it on the next startup."""
        name = "s526-" + uuid.uuid4().hex
        result = self.marionette.execute_script("""
            const service = Cc['@mozilla.org/toolkit/profile-service;1']
              .getService(Ci.nsIToolkitProfileService);
            const root = Services.dirsvc.get('ProfD', Ci.nsIFile);
            const profile = service.createProfile(root, arguments[0], 'tests');
            service.flush();
            return {name: profile.name, path: profile.rootDir.path,
              current: service.currentProfile?.name ?? null};
        """, script_args=[name])
        self.assertEqual(name, result["name"])
        self.assertEqual(self.profile, Path(result["path"]).resolve())
        self.registered_profiles.add(name)
        return name

    def assert_profile_registration(self, name):
        """Check the real XRE-selected toolkit profile, including unnamed paths."""
        actual = self.marionette.execute_script("""
            return Cc['@mozilla.org/toolkit/profile-service;1']
              .getService(Ci.nsIToolkitProfileService).currentProfile?.name ?? null;
        """)
        self.assertEqual(name, actual)

    def write_legacy_cache(self, rows):
        """Encode retained native folder fields as a complete legacy Mork cache."""
        def cell(value):
            return "".join("$%02X" % byte for byte in str(value).encode("utf-8"))
        columns = {"key": "82", "flags": "83", "folderName": "84",
                   "onlineName": "85", "hierDelim": "86", "boxFlags": "87",
                   "pendingMsgs": "88"}
        text = ('// <!-- <mdb:mork:z v="1.4"/> -->\n'
                '< <(a=c)> (80=ns:msg:db:row:scope:folders:all)'
                '(81=ns:msg:db:table:kind:folders)' +
                ''.join('(%s=%s)' % (atom, column)
                        for column, atom in columns.items()) + '>\n'
                '{1:^80 {(k^81:c)(s=9)}\n')
        for index, row in enumerate(rows, 1):
            text += '[%X' % index + ''.join(
                '(^%s=%s)' % (columns[column], cell(value))
                for column, value in row.items()) + ']\n'
        path = self.profile / "panacea.dat"
        path.write_bytes((text + '}\n').encode("ascii"))
        return path

    def test_preservesSupportedNativeLogicalNames(self):
        for store, name in [("mbox", "100% Real"),
                            ("maildir", "Original logical name " + "long" * 45)]:
            self.clean_profile(False)
            source = self.create_legacy_message(store, name)
            self.stop_application()
            original = Path(source["summary"]).read_bytes()
            self.start_same_profile(True)
            selected = self.selection()
            self.assertEqual("migrated", selected["record"]["origin"])
            headers = self.assert_message_after_activation(source)
            self.assertEqual(original, Path(source["summary"]).read_bytes())
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.assertEqual(headers, self.assert_message_after_activation(source))

    def test_preservesSeveralRenamedLocalSiblingsAndTheirChildren(self):
        """Several folders of one parent whose file names differ from their names
        (Thunderbird hashes a name that cannot be a file name), beside ordinary
        siblings and with children of their own. All data is fabricated."""
        self.clean_profile(False)
        names = ["100% Real", "Colon: name", "Question? mark", "Plain",
                 "Original logical name " + "long" * 12]
        source = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            const root = new FileUtils.File(PathUtils.join(PathUtils.profileDir,
              'Mail', 's526-renamed-siblings'));
            root.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            const server = MailServices.accounts.createIncomingServer(
              's526siblings', 'localhost', 'none');
            server.localPath = root;
            MailServices.accounts.createAccount().incomingServer = server;
            const folders = {};
            const add = (parent, name, path) => {
              parent.createSubfolder(name, null);
              const folder = parent.getChildNamed(name)
                .QueryInterface(Ci.nsIMsgLocalMailFolder);
              folder.addMessage(
                'From - Thu Nov 05 00:00:00 2026\r\n' +
                'Message-ID: <' + Object.keys(folders).length + '-siblings@invalid>\r\n' +
                'From: source@example.invalid\r\n' +
                'Subject: In ' + path + '\r\n' +
                'Date: Thu, 5 Nov 2026 00:00:00 +0000\r\n\r\n' +
                'Body.\r\n');
              folder.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
              folders[path] = {summary: folder.summaryFile.path,
                               leaf: folder.filePath.leafName};
              return folder;
            };
            for (const name of arguments[0]) {
              const folder = add(server.rootFolder, name, name);
              add(folder, 'Child: of ' + name.slice(0, 8), name + '/child');
              add(folder, 'Second', name + '/second');
            }
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, folders};
        """, script_args=[names])
        self.stop_application()
        renamed = [path for path, folder in source["folders"].items()
                   if "/" not in path and folder["leaf"] != path]
        self.assertGreaterEqual(len(renamed), 3, "Several siblings have another file name")
        originals = {path: Path(folder["summary"]).read_bytes()
                     for path, folder in source["folders"].items()}

        def subjects():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                const root = MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder;
                const state = {};
                for (const name of arguments[1]) {
                  const folder = root.getChildNamed(name);
                  const read = item => [...item.msgDatabase.enumerateMessages()]
                    .map(header => header.subject);
                  state[name] = read(folder);
                  for (const child of folder.subFolders) {
                    state[name + '/' + child.name] = read(child);
                  }
                }
                return state;
            """, script_args=[source["serverKey"], names])

        expected = {}
        for name in names:
            expected[name] = ["In " + name]
            expected[name + "/Child: of " + name[:8]] = ["In " + name + "/child"]
            expected[name + "/Second"] = ["In " + name + "/second"]
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(expected, subjects())
        for path, folder in source["folders"].items():
            self.assertEqual(originals[path], Path(folder["summary"]).read_bytes())
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.assertEqual(expected, subjects())

    def test_keepsSavedSearchAndAddsDerivedSpecialUse(self):
        """The flags word of a summary stands: a saved search stays Virtual. A
        folder old discovery marks by its name (SetFlagsOnDefaultMailboxes)
        gets that special use again. All data is fabricated."""
        self.clean_profile(False)
        source = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            const { VirtualFolderHelper } = ChromeUtils.importESModule(
              'resource:///modules/VirtualFolderWrapper.sys.mjs');
            const root = new FileUtils.File(PathUtils.join(PathUtils.profileDir,
              'Mail', 's526-saved-search'));
            root.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            const server = MailServices.accounts.createIncomingServer(
              's526search', 'localhost', 'none');
            server.localPath = root;
            MailServices.accounts.createAccount().incomingServer = server;
            const add = name => {
              server.rootFolder.createSubfolder(name, null);
              const folder = server.rootFolder.getChildNamed(name)
                .QueryInterface(Ci.nsIMsgLocalMailFolder);
              folder.addMessage(
                'From - Thu Nov 05 00:00:00 2026\r\n' +
                'Message-ID: <' + name.toLowerCase() + '-search@invalid>\r\n' +
                'From: source@example.invalid\r\n' +
                'Subject: In ' + name + '\r\n' +
                'Date: Thu, 5 Nov 2026 00:00:00 +0000\r\n\r\n' +
                'Body.\r\n');
              folder.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
              return folder;
            };
            const searched = add('Searched');
            // A folder with a default name whose word lost its special use.
            const drafts = add('Drafts');
            drafts.clearFlag(Ci.nsMsgFolderFlags.Drafts);
            drafts.msgDatabase.dBFolderInfo.flags = drafts.flags;
            drafts.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            const wrapper = VirtualFolderHelper.createNewVirtualFolder(
              'Saved search', server.rootFolder, [searched],
              [{matchAll: true}], false);
            const virtual = wrapper.virtualFolder;
            virtual.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            MailServices.accounts.saveVirtualFolders();
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key,
              virtualSummary: virtual.summaryFile.path,
              virtualFlags: virtual.flags >>> 0,
              draftsFlags: drafts.flags >>> 0};
        """)
        self.stop_application()
        self.assertTrue(source["virtualFlags"] & 0x20, "The fixture is a saved search")
        self.assertFalse(source["draftsFlags"] & 0x400)
        summary = Path(source["virtualSummary"])
        original = summary.read_bytes()
        # The old application's own cache describes the saved search too.
        cache = json.loads((self.profile / "folderCache.json").read_text(encoding="utf-8"))
        self.assertIn(str(summary), cache)

        def state():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                const root = MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder;
                const read = name => {
                  const folder = root.getChildNamed(name);
                  return folder && {
                    virtual: !!(folder.flags & Ci.nsMsgFolderFlags.Virtual),
                    drafts: !!(folder.flags & Ci.nsMsgFolderFlags.Drafts),
                    subjects: folder.flags & Ci.nsMsgFolderFlags.Virtual ? [] :
                      [...folder.msgDatabase.enumerateMessages()].map(h => h.subject)};
                };
                return {search: read('Saved search'), searched: read('Searched'),
                        drafts: read('Drafts')};
            """, script_args=[source["serverKey"]])

        expected = {
            "search": {"virtual": True, "drafts": False, "subjects": []},
            "searched": {"virtual": False, "drafts": False, "subjects": ["In Searched"]},
            "drafts": {"virtual": False, "drafts": True, "subjects": ["In Drafts"]},
        }
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(expected, state())
        self.assertEqual(original, summary.read_bytes())
        # A search folder's cache entry is a recomputed view: not applied, counted.
        report = json.loads(
            (Path(selected["record"]["identity"]["journalPath"]).parent /
             "report.json").read_text(encoding="utf-8"))
        self.assertIn("search-folder-cache-entries",
                      [entry["code"] for entry in report["notImported"]])
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.assertEqual(expected, state())

    def test_migratesWatchedThreadAndStaleDerivedThreadData(self):
        """Counts and per-thread caches are derived data real summaries leave
        stale; a thread's watch word is user data. All data is fabricated."""
        self.clean_profile(False)
        source = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            const root = new FileUtils.File(PathUtils.join(PathUtils.profileDir,
              'Mail', 's526-derived'));
            root.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            const server = MailServices.accounts.createIncomingServer(
              's526derived', 'localhost', 'none');
            server.localPath = root;
            MailServices.accounts.createAccount().incomingServer = server;
            server.rootFolder.createSubfolder('Threads', null);
            const folder = server.rootFolder.getChildNamed('Threads')
              .QueryInterface(Ci.nsIMsgLocalMailFolder);
            const add = (id, subject, references) => folder.addMessage(
              'From - Thu Nov 05 00:00:00 2026\r\n' +
              'Message-ID: <' + id + '@invalid>\r\n' +
              (references ? 'References: <' + references + '@invalid>\r\n' : '') +
              'From: source@example.invalid\r\n' +
              'Subject: ' + subject + '\r\n' +
              'Date: Thu, 5 Nov 2026 00:00:00 +0000\r\n\r\n' +
              'Body.\r\n');
            const first = add('derived-root', 'Watched thread', null);
            const reply = add('derived-reply', 'Re: Watched thread', 'derived-root');
            add('derived-other', 'Another thread', null);
            const database = folder.msgDatabase;
            // A header without its own account cell belongs to the account
            // of its folder's server.
            const bare = database.createNewHdr(0x7000);
            bare.messageId = 'derived-bare@invalid';
            bare.subject = 'No account cell';
            bare.author = 'source@example.invalid';
            bare.date = Date.UTC(2026, 10, 5) * 1000;
            database.addNewHdrToDB(bare, true);
            database.markThreadWatched(
              database.getThreadContainingMsgHdr(first), first.messageKey, true, null);
            // What real summaries leave stale: a parent that no longer exists
            // and cached counts that no longer match.
            reply.threadParent = 0x7fff0001;
            database.dBFolderInfo.changeNumMessages(40);
            database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, summary: folder.summaryFile.path,
              watched: database.isWatched(first.messageKey),
              count: database.dBFolderInfo.numMessages};
        """)
        self.stop_application()
        self.assertTrue(source["watched"])
        self.assertEqual(44, source["count"], "The fixture's cached count is stale")
        original = Path(source["summary"]).read_bytes()

        def state():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                const folder = MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder.getChildNamed('Threads');
                const database = folder.msgDatabase;
                const headers = Object.fromEntries(
                  [...database.enumerateMessages()].map(h => [h.messageId, h]));
                const first = headers['derived-root@invalid'];
                const reply = headers['derived-reply@invalid'];
                const other = headers['derived-other@invalid'];
                return {
                  subjects: Object.values(headers).map(h => h.subject).sort(),
                  bareAccount: headers['derived-bare@invalid'].accountKey ===
                    MailServices.accounts.findAccountForServer(folder.server).key,
                  total: folder.getTotalMessages(false),
                  watched: database.isWatched(first.messageKey),
                  otherWatched: database.isWatched(other.messageKey),
                  sameThread: reply.threadId === first.threadId,
                  below: reply.threadParent === first.messageKey,
                  otherThread: other.threadId !== first.threadId,
                };
            """, script_args=[source["serverKey"]])

        expected = {
            "subjects": ["Another thread", "No account cell", "Re: Watched thread",
                         "Watched thread"],
            "bareAccount": True,
            "total": 4, "watched": True, "otherWatched": False,
            "sameThread": True, "below": True, "otherThread": True,
        }
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(expected, state())
        self.assertEqual(original, Path(source["summary"]).read_bytes())
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.assertEqual(expected, state())

    def test_namedAndUnnamedActualSelection(self):
        self.clean_profile(True)
        first = self.selection()
        self.assert_profile_registration(None)
        name = self.register_selected_profile()
        self.stop_application()
        self.start_same_profile(True)
        self.assert_profile_registration(name)
        self.assertEqual(first["sourceId"], self.selection()["sourceId"])
        self.stop_application()
        self.start_same_profile(True)
        self.assert_profile_registration(name)
        self.assertEqual(first["sourceId"], self.selection()["sourceId"])

    def test_migratesNamedBookAndReusesPublicDirectory(self):
        self.assert_book_migration(True)

    def test_migratesBookInUnregisteredProfilePath(self):
        """A --profile <path> start has no registered profile; its lock selects it."""
        self.assert_book_migration(False)

    def assert_book_migration(self, registered):
        self.clean_profile(False)
        name = self.register_selected_profile() if registered else None
        source = self.profile / "s526-original.mab"
        # A packaged copy of mail/components/addrbook/test/browser/data/import.mab;
        # the marionette test archive does not contain other test directories.
        fixture = Path(__file__).resolve().parent / "data" / "import.mab"
        source.write_bytes(fixture.read_bytes())
        self.marionette.execute_script("""
            Services.prefs.setStringPref('ldap_2.servers.s526.filename', arguments[0]);
            Services.prefs.setStringPref('ldap_2.servers.s526.description',
              'Original migration book');
            Services.prefs.savePrefFile(null);
        """, script_args=[source.name])
        self.stop_application()
        original = source.read_bytes()
        self.start_same_profile(True)
        self.assert_profile_registration(name)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(1, len(selected["record"]["identity"]["books"]))
        def public_book():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                return [...MailServices.ab.directories]
                  .filter(book => book.dirName === 'Original migration book')
                  .map(book => ({uid: book.UID, uri: book.URI,
                    emails: [...book.childCards].filter(card => !card.isMailList)
                      .map(card => card.primaryEmail).sort(),
                    lists: [...book.childNodes].map(list => ({
                      name: list.dirName,
                      emails: [...list.childCards].map(card => card.primaryEmail).sort()
                    })).sort((a, b) => a.name.localeCompare(b.name))}));
            """)
        books = public_book()
        self.assertEqual(1, len(books))
        # The pinned import.mab contains one card and one one-member list.
        self.assertEqual(["contact1@invalid"], books[0]["emails"])
        self.assertEqual([{"name": "list", "emails": ["contact1@invalid"]}],
                         books[0]["lists"])
        self.assertEqual(original, source.read_bytes())
        self.stop_application()
        selector = (self.profile / "panorama-profile.json").read_bytes()
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(books, public_book())
        self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
        self.assertEqual(original, source.read_bytes())

        # Ordinary deletion retires the publication; historical receipts remain.
        publication = selected["record"]["identity"]["books"][0]["publication"]
        journal = Path(selected["record"]["identity"]["journalPath"])
        original_journal = journal.read_bytes()
        deleted = self.marionette.execute_async_script("""
            const uri = arguments[0];
            const done = arguments[arguments.length - 1];
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const book = MailServices.ab.getDirectory(uri);
            const uid = book.UID;
            const prefId = book.dirPrefId;
            const fileName = book.fileName;
            const observer = {
              observe(subject) {
                if (subject.QueryInterface(Ci.nsIAbDirectory).URI !== uri) {
                  return;
                }
                Services.obs.removeObserver(observer, 'addrbook-directory-deleted');
                Services.prefs.savePrefFile(null);
                done({uid, prefId, fileName,
                  prefKeys: Services.prefs.getChildList(prefId + '.'),
                  present: [...MailServices.ab.directories].some(dir => dir.URI === uri)});
              },
            };
            Services.obs.addObserver(observer, 'addrbook-directory-deleted');
            try {
              MailServices.ab.deleteAddressBook(uri);
            } catch (error) {
              Services.obs.removeObserver(observer, 'addrbook-directory-deleted');
              done({error: String(error)});
            }
        """, script_args=[books[0]["uri"]])
        self.assertNotIn("error", deleted)
        self.assertEqual(publication["bookUID"], deleted["uid"])
        self.assertEqual(publication["dirPrefId"], deleted["prefId"])
        self.assertEqual(publication["fileName"], deleted["fileName"])
        self.assertEqual([], deleted["prefKeys"])
        self.assertFalse(deleted["present"])
        published_file = self.profile / deleted["fileName"]
        self.assertFalse(published_file.exists())
        self.assertEqual([], public_book())
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected, self.selection())
            self.assertEqual([], public_book())
            self.assertFalse(published_file.exists())
            self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
            self.assertEqual(original_journal, journal.read_bytes())
            self.assertEqual(original, source.read_bytes())

    def test_migratesCacheAndReusesCommittedProjection(self):
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        self.stop_application()
        cache = self.write_legacy_cache([{"key": source["summary"],
            "flags": format(source["flags"] & 0xffffffff, "x"),
            "folderName": source["name"]}])
        original = cache.read_bytes()
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        caches = selected["record"]["identity"]["caches"]
        self.assertEqual(1, len(caches))
        self.assertTrue(caches[0]["receipt"])
        headers = self.assert_message_after_activation(source)
        self.assertEqual(original, cache.read_bytes())
        self.stop_application()
        self.start_same_profile(True)
        repeated = self.selection()
        self.assertEqual(selected["sourceId"], repeated["sourceId"])
        self.assertEqual(caches, repeated["record"]["identity"]["caches"])
        self.assertEqual(headers, self.assert_message_after_activation(source))
        self.assertEqual(original, cache.read_bytes())

    def test_cacheOnlyStartupKeepsNativeRootIdentity(self):
        self.clean_profile(False)
        accounts = self.marionette.execute_script("""
            return Services.prefs.getCharPref('mail.accountmanager.accounts', '');
        """)
        self.stop_application()
        root = self.profile / "Mail" / "cache-only"
        root.mkdir(parents=True)
        # Persist the ordinary account before its first native root open. Opening
        # a legacy local root here would create Trash/Outbox Mork summaries.
        self.marionette.instance.profile.set_preferences({
            "mail.accountmanager.accounts": ",".join(
                [value for value in [accounts, "accountS526"] if value]),
            "mail.account.accountS526.server": "serverS526",
            "mail.server.serverS526.type": "none",
            "mail.server.serverS526.hostname": "localhost",
            "mail.server.serverS526.userName": "cache-only",
            "mail.server.serverS526.name": "Cache only",
            "mail.server.serverS526.directory-rel": "[ProfD]Mail/cache-only",
            "mail.server.serverS526.storeContractID":
                "@mozilla.org/msgstore/berkeleystore;1",
        })
        source = {"key": str(root), "folderName": "Cache only"}
        self.assertFalse(list(root.rglob("*.msf")))
        obsolete = self.write_legacy_cache([source])
        obsolete_bytes = obsolete.read_bytes()
        cache = self.profile / "folderCache.json"
        cache.write_text(json.dumps({source["key"]: {
            "folderName": source["folderName"]}}), encoding="utf-8")
        original = cache.read_bytes()
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual([], selected["record"]["identity"]["imports"])
        self.assertEqual(1, len(selected["record"]["identity"]["caches"]))
        self.assertEqual(original, cache.read_bytes())
        identity = selected["record"]["identity"]["caches"][0]["receipt"]["identity"]
        self.assertEqual(str(cache), identity["path"])
        self.assertEqual(3, identity["version"])
        self.assertEqual("json", identity["sourceFormat"])
        self.assertEqual(obsolete_bytes, obsolete.read_bytes())
        self.stop_application()
        self.start_same_profile(True)
        repeated = self.selection()
        self.assertEqual(selected["sourceId"], repeated["sourceId"])
        self.assertEqual(selected["record"]["identity"], repeated["record"]["identity"])
        self.assertEqual(original, cache.read_bytes())
        self.assertEqual(obsolete_bytes, obsolete.read_bytes())

    def create_cache_only_root(self, name):
        """Persist an ordinary local account whose root has only cache metadata."""
        self.clean_profile(False)
        accounts = self.marionette.execute_script("""
            return Services.prefs.getCharPref('mail.accountmanager.accounts', '');
        """)
        self.stop_application()
        root = self.profile / "Mail" / name
        root.mkdir(parents=True)
        self.marionette.instance.profile.set_preferences({
            "mail.accountmanager.accounts": ",".join(
                [value for value in [accounts, "accountS526"] if value]),
            "mail.account.accountS526.server": "serverS526",
            "mail.server.serverS526.type": "none",
            "mail.server.serverS526.hostname": "localhost",
            "mail.server.serverS526.userName": name,
            "mail.server.serverS526.name": "Cache only",
            "mail.server.serverS526.directory-rel": "[ProfD]Mail/" + name,
            "mail.server.serverS526.storeContractID":
                "@mozilla.org/msgstore/berkeleystore;1",
        })
        self.assertFalse(list(root.rglob("*.msf")))
        return root

    def outside_profile(self):
        """A temporary directory outside the profile, removed after the test."""
        path = Path(tempfile.mkdtemp(prefix="comm-cache-history-")).resolve()
        self.addCleanup(shutil.rmtree, path, True)
        return path

    def assert_json_cache_migration(self, cache, entries, bound, unbound):
        """Migrate a native JSON cache, then reuse it twice unchanged."""
        cache.write_text(json.dumps(entries), encoding="utf-8")
        original = cache.read_bytes()
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(1, len(selected["record"]["identity"]["caches"]))
        identity = selected["record"]["identity"]["caches"][0]["receipt"]["identity"]
        self.assertEqual(3, identity["version"])
        self.assertEqual([bound], [folder["originalKey"] for folder in identity["folders"]])
        self.assertEqual(sorted(unbound), identity.get("unboundKeys", []))
        # The complete original, obsolete entries included, stays unchanged
        # in place and in the verified backup.
        self.assertEqual(original, cache.read_bytes())
        backup = Path(selected["record"]["identity"]["backup"]["path"]).parent
        self.assertEqual(original, (backup / "root-0" / cache.name).read_bytes())
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            repeated = self.selection()
            self.assertEqual(selected["sourceId"], repeated["sourceId"])
            self.assertEqual(selected["record"]["identity"],
                             repeated["record"]["identity"])
            self.assertEqual(original, cache.read_bytes())

    def test_movedProfileJsonCacheSkipsObsoleteEntries(self):
        root = self.create_cache_only_root("cache-moved")
        # Legacy writes null for a cell without a value and reads it as empty.
        current = {"folderName": "Cache only", "MRMTime": None, "nextUID": None}
        outside = self.outside_profile()
        # Legacy never prunes entries of an earlier profile location.
        absent = outside / "old-location" / "Mail" / "cache-moved"
        unrelated = outside / "other-profile" / "Mail" / "cache-moved"
        unrelated.mkdir(parents=True)
        entries = {str(root): current, str(absent): current,
                   str(unrelated): current,
                   # Legacy writes a folder without a file path under an empty
                   # key; a key that is no absolute path reaches no folder.
                   "": {"folderName": "No path"},
                   "relative-descriptor": current}
        if sys.platform != "win32":
            # Another spelling of the current root, superseded by its exact entry.
            link = outside / "linked-mail"
            link.symlink_to(root.parent, target_is_directory=True)
            entries[str(link / root.name)] = {"folderName": "Superseded"}
        self.assert_json_cache_migration(
            self.profile / "folderCache.json", entries, str(root),
            [key for key in entries if key != str(root)])
        self.assertTrue(unrelated.is_dir())

    @unittest.skipIf(sys.platform == "win32", "needs a POSIX directory link")
    def test_jsonCacheEntryUnderAnotherSpellingStaysBound(self):
        root = self.create_cache_only_root("cache-spelled")
        link = self.outside_profile() / "spelled-mail"
        link.symlink_to(root.parent, target_is_directory=True)
        spelled = str(link / root.name)
        self.assert_json_cache_migration(
            self.profile / "folderCache.json",
            {spelled: {"folderName": "Cache only"}}, spelled, [])

    def create_legacy_imap_source(self, pending=False, offline=False):
        """Create genuine root and UID-bearing child summaries with legacy APIs."""
        self.clean_profile(False)
        source = self.marionette.execute_script("""
            const [pending, offline] = arguments;
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            Services.io.offline = true;
            Services.prefs.setBoolPref('network.manage-offline-status', false);
            Services.prefs.setIntPref('offline.startup_state', 2);
            const server = MailServices.accounts.createIncomingServer(
              's526', 'imap.invalid', 'imap');
            // Account creation can already expose the server to native listeners.
            // Keep its normal persisted root instead of relocating a live server.
            const file = server.localPath;
            server.setBoolValue('login_at_startup', false);
            server.setBoolValue('download_on_biff', false);
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const root = server.rootFolder.QueryInterface(Ci.nsIMsgImapMailFolder);
            if (!root.containsChildNamed('INBOX')) {
                root.createClientSubfolderInfo('INBOX', '/', 0, true);
            }
            const folder = server.rootFolder.getChildNamed('INBOX');
            const imap = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
            imap.onlineName = 'INBOX';
            imap.hierarchyDelimiter = '/';
            const database = folder.msgDatabase;
            database.dBFolderInfo.setUint32Property('UIDValidity', 526);
            database.dBFolderInfo.setCharProperty('onlineName', 'INBOX');
            const header = database.createNewHdrWithSpecificMsgKey(42);
            header.messageId = 'imap-activation-s526@invalid';
            header.subject = 'Original IMAP startup migration';
            header.setUint32Property('uidOnServer', 42);
            header.setStringProperty('s526-custom', 'imap-retained');
            if (offline) {
              // An offline copy whose token finds no message in the store.
              header.orFlags(Ci.nsMsgMessageFlags.Offline);
              header.storeToken = '4096';
            }
            database.addNewHdrToDB(header, false);
            if (pending) {
              // What a copy into this folder leaves until its message arrives,
              // and for good when it never does.
              database.setAttributeOnPendingHdr(header, 'keywords', 's526-later');
              database.setUint32AttributeOnPendingHdr(header, 'flags', 4);
            }
            database.summaryValid = true;
            database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root: file.path,
              rootSummary: server.rootFolder.summaryFile.path,
              summary: folder.summaryFile.path, store: folder.filePath.path,
              flags: (database.dBFolderInfo.flags >>> 0).toString(16),
              folderName: folder.name, onlineName: imap.onlineName,
              hierDelim: imap.hierarchyDelimiter.charCodeAt(0).toString(16),
              boxFlags: '0'};
        """, script_args=[pending, offline])
        return source

    def test_migratesImapOfflineMessageWithoutReadingItsStore(self):
        """The migration imports the index and never reads a message body. An
        offline token that finds no message in its store refuses nothing, as
        in old Thunderbird, which fetches such a message again. All data is
        fabricated."""
        source = self.create_legacy_imap_source(offline=True)
        self.stop_application()
        summary = Path(source["summary"])
        store = Path(source["store"])
        garbage = b"no mbox separator anywhere in this offline store " * 8
        store.write_bytes(garbage)
        original = summary.read_bytes()
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        messages = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const folder = MailServices.accounts.getIncomingServer(arguments[0])
              .rootFolder.getChildNamed('INBOX');
            return [...folder.msgDatabase.enumerateMessages()].map(header => ({
              id: header.messageId, token: header.storeToken,
              offline: !!(header.flags & Ci.nsMsgMessageFlags.Offline)}));
        """, script_args=[source["serverKey"]])
        self.assertEqual([{"id": "imap-activation-s526@invalid", "token": "4096",
                           "offline": True}], messages)
        self.assertEqual(garbage, store.read_bytes())
        self.assertEqual(original, summary.read_bytes())
        self.stop_application()
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(garbage, store.read_bytes())

    def test_migratesImapSummaryWithPendingHeaderAttributes(self):
        """Attributes kept for a message that has not arrived yet have no
        native place: the folder migrates, the report counts them and the
        original summary keeps them. All data is fabricated."""
        source = self.create_legacy_imap_source(True)
        self.stop_application()
        summary = Path(source["summary"])
        original = summary.read_bytes()
        self.assertIn(b"ns:msg:db:row:scope:pending:all", original)
        self.assertIn(b"s526-later", original)
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        messages = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const folder = MailServices.accounts.getIncomingServer(arguments[0])
              .rootFolder.getChildNamed('INBOX');
            return [...folder.msgDatabase.enumerateMessages()].map(header => ({
              id: header.messageId, uid: header.getUint32Property('uidOnServer'),
              keywords: header.getStringProperty('keywords')}));
        """, script_args=[source["serverKey"]])
        self.assertEqual([{"id": "imap-activation-s526@invalid", "uid": 42,
                           "keywords": ""}], messages)
        self.assertEqual(original, summary.read_bytes())
        report = json.loads(
            (Path(selected["record"]["identity"]["journalPath"]).parent /
             "report.json").read_text(encoding="utf-8"))
        self.assertEqual(1, report["version"])
        self.assertEqual("migrated", report["outcome"])
        self.assertIn({"code": "pending-header-attributes", "sources": 1,
                       "count": 1}, report["notImported"])
        self.stop_application()
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])

    def test_migratesNativeImapUidAndCacheThenReuses(self):
        source = self.create_legacy_imap_source()
        self.assertTrue(Path(source["summary"]).is_relative_to(Path(source["root"])))
        self.stop_application()
        summary = Path(source["summary"])
        original = summary.read_bytes()
        root_summary = Path(source["rootSummary"])
        self.assertEqual(Path(source["root"] + ".msf"), root_summary)
        self.assertTrue(root_summary.is_file())
        self.assertFalse(root_summary.is_symlink())
        root_original = root_summary.read_bytes()
        # The cache also knows of five messages the server has and the
        # summary does not yet.
        cache = self.write_legacy_cache([{"key": str(summary), "pendingMsgs": "5", **{
            name: source[name] for name in
            ["flags", "folderName", "onlineName", "hierDelim", "boxFlags"]}}])
        cache_bytes = cache.read_bytes()
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(1, len(selected["record"]["identity"]["imports"]))
        self.assertEqual(1, len(selected["record"]["identity"]["caches"]))

        def shown_total():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                return MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder.getChildNamed('INBOX').getTotalMessages(false);
            """, script_args=[source["serverKey"]])
        # The session that migrated shows what every later session shows.
        self.assertEqual(6, shown_total())
        root_bindings = selected["record"]["identity"]["serverSummaries"]
        self.assertEqual(1, len(root_bindings))
        self.assertEqual("server-summary:" + root_summary.relative_to(self.profile).as_posix(),
                         root_bindings[0]["sourceId"])
        actual_root_id = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            return MailServices.accounts.getIncomingServer(arguments[0]).rootFolder.id;
        """, script_args=[source["serverKey"]])
        self.assertEqual(actual_root_id, root_bindings[0]["folderId"])
        backup = Path(selected["record"]["identity"]["backup"]["path"])
        archived_root = backup.parent / "root-0" / root_summary.relative_to(self.profile)
        self.assertEqual(root_original, root_summary.read_bytes())
        self.assertEqual(root_original, archived_root.read_bytes())
        def imported():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                const folder = MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder.getChildNamed('INBOX');
                return [...folder.msgDatabase.enumerateMessages()].map(header => ({
                  key: header.messageKey, id: header.messageId,
                  uid: header.getUint32Property('uidOnServer'),
                  value: header.getStringProperty('s526-custom')}));
            """, script_args=[source["serverKey"]])
        messages = imported()
        self.assertEqual(1, len(messages))
        self.assertEqual("imap-activation-s526@invalid", messages[0]["id"])
        self.assertEqual(42, messages[0]["uid"])
        self.assertEqual("imap-retained", messages[0]["value"])
        self.assertEqual(original, summary.read_bytes())
        self.assertEqual(cache_bytes, cache.read_bytes())
        self.assertEqual(root_original, root_summary.read_bytes())
        self.assertEqual(root_original, archived_root.read_bytes())
        self.stop_application()
        self.start_same_profile(True)
        repeated = self.selection()
        self.assertEqual(selected["sourceId"], repeated["sourceId"])
        self.assertEqual(root_bindings, repeated["record"]["identity"]["serverSummaries"])
        self.assertEqual(messages, imported())
        self.assertEqual(6, shown_total())
        self.assertEqual(original, summary.read_bytes())
        self.assertEqual(cache_bytes, cache.read_bytes())
        self.assertEqual(root_original, root_summary.read_bytes())
        self.assertEqual(root_original, archived_root.read_bytes())

        self.stop_application()
        journal = Path(selected["record"]["identity"]["journalPath"])
        original_journal = journal.read_bytes()
        retained = json.loads(original_journal)
        self.assertEqual(root_bindings, retained["startup"]["serverSummaries"])
        retained["startup"]["serverSummaries"][0]["folderId"] += 1
        journal.write_text(json.dumps(retained), encoding="utf-8")
        self.assert_startup_refuses([
            journal, self.profile / "panorama-profile.json", summary,
            root_summary, cache, archived_root,
        ])
        journal.write_bytes(original_journal)
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(messages, imported())
        self.assertEqual(root_original, root_summary.read_bytes())
        self.assertEqual(original_journal, journal.read_bytes())

        # Remove the real account, retaining the user's original on-disk store.
        selector = (self.profile / "panorama-profile.json").read_bytes()
        retired = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const core = Cc['@mozilla.org/mailnews/database-core;1']
              .getService(Ci.nsIDatabaseCore);
            const key = arguments[0];
            const server = MailServices.accounts.getIncomingServer(key);
            const account = MailServices.accounts.findAccountForServer(server);
            if (!account) {
              throw new Error('Migrated account is unavailable before removal');
            }
            const before = core.folderDB.getFolderByPath(key);
            MailServices.accounts.removeAccount(account, false);
            Services.prefs.savePrefFile(null);
            return {before, after: core.folderDB.getFolderByPath(key),
              present: MailServices.accounts.allServers.some(item => item.key === key)};
        """, script_args=[source["serverKey"]])
        self.assertEqual(actual_root_id, retired["before"])
        self.assertEqual(0, retired["after"])
        self.assertFalse(retired["present"])
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected, self.selection())
            absent = self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                const core = Cc['@mozilla.org/mailnews/database-core;1']
                  .getService(Ci.nsIDatabaseCore);
                return {root: core.folderDB.getFolderByPath(arguments[0]),
                  present: MailServices.accounts.allServers.some(
                    item => item.key === arguments[0])};
            """, script_args=[source["serverKey"]])
            self.assertEqual({"root": 0, "present": False}, absent)
            self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
            self.assertEqual(original_journal, journal.read_bytes())
            self.assertEqual(original, summary.read_bytes())
            self.assertEqual(root_original, root_summary.read_bytes())
            self.assertEqual(cache_bytes, cache.read_bytes())
            self.assertEqual(root_original, archived_root.read_bytes())

    def create_legacy_offline_imap_shapes(self, personal=False, unified=False,
                                          readded=False, drafts=False, stale=False):
        """Write ordinary summaries of an IMAP account last used offline.

        All data is fabricated. INBOX always holds two headers; the options add
        one legacy shape each (see the tests below)."""
        self.clean_profile(False)
        return self.marionette.execute_script("""
            const [personal, unified, readded, drafts, stale] = arguments;
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { MorkParser } = ChromeUtils.importESModule(
              'resource:///modules/MorkParser.sys.mjs');
            const { NetUtil } = ChromeUtils.importESModule(
              'resource://gre/modules/NetUtil.sys.mjs');
            Services.io.offline = true;
            Services.prefs.setBoolPref('network.manage-offline-status', false);
            Services.prefs.setIntPref('offline.startup_state', 2);
            const server = MailServices.accounts.createIncomingServer(
              's526shapes', 'imap.invalid', 'imap');
            server.setBoolValue('login_at_startup', false);
            server.setBoolValue('download_on_biff', false);
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const root = server.rootFolder.QueryInterface(Ci.nsIMsgImapMailFolder);
            const folders = {};
            const create = (name, validity) => {
              if (!root.containsChildNamed(name)) {
                root.createClientSubfolderInfo(name, '/', 0, true);
              }
              const folder = server.rootFolder.getChildNamed(name);
              const imap = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
              imap.onlineName = name;
              imap.hierarchyDelimiter = '/';
              const database = folder.msgDatabase;
              database.dBFolderInfo.setCharProperty('onlineName', name);
              if (validity) {
                database.dBFolderInfo.setUint32Property('UIDValidity', validity);
              }
              return folder;
            };
            const add = (database, key, subject) => {
              const header = database.createNewHdrWithSpecificMsgKey(key);
              header.messageId = 'shape-' + key + '-' + subject + '@invalid';
              header.subject = subject;
              header.setUint32Property('uidOnServer', key);
              database.addNewHdrToDB(header, false);
            };
            const created = [];
            const inbox = create('INBOX', 526);
            let database = inbox.msgDatabase;
            add(database, 42, 'Inbox first');
            add(database, 43, 'Inbox second');
            if (personal) {
              // The summary word keeps the personal namespace flag of an
              // earlier LIST; the cached box flags restored offline carry none.
              inbox.setFlag(Ci.nsMsgFolderFlags.ImapPersonal);
            }
            if (unified) {
              // A unified folder view caches its hits in the summary.
              database.refreshCache('mailbox://nobody@smart%20mailboxes/Inbox',
                                    [42, 43]);
            }
            if (stale) {
              // What an offline move leaves in its destination once the source
              // folder's operation is gone: a pseudo header and a move result
              // naming a source no folder has an operation for.
              const ghost = database.createNewHdrWithSpecificMsgKey(0xffffff80);
              ghost.messageId = 'shape-ghost@invalid';
              ghost.subject = 'Moved here offline';
              ghost.setUint32Property('pseudoHdr', 1);
              database.addNewHdrToDB(ghost, false);
              const result = database.QueryInterface(Ci.nsIMsgOfflineOpsDatabase)
                .getOfflineOpForKey(0xffffff80, true);
              result.sourceFolderURI = server.rootFolder.URI + '/Elsewhere';
              result.srcMessageKey = 77;
            }
            database.summaryValid = true;
            database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            created.push(['INBOX', inbox]);
            if (readded) {
              // Removing and adding a header again leaves a live thread
              // outside the derived all-threads subject index.
              const sent = create('Sent', 527);
              database = sent.msgDatabase;
              add(database, 1, 'Sent first');
              add(database, 2, 'Sent second');
              database.deleteHeader(database.getMsgHdrForKey(2), null, false, false);
              database.commit(Ci.nsMsgDBCommitType.kSessionCommit);
              add(database, 2, 'Sent second');
              if (unified) {
                database.refreshCache('mailbox://nobody@smart%20mailboxes/Sent',
                                      [1, 2]);
              }
              database.summaryValid = true;
              database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
              created.push(['Sent', sent]);
            }
            if (drafts) {
              // A compress commit of an empty folder keeps only folder info.
              const folder = create('Drafts', 528);
              database = folder.msgDatabase;
              database.summaryValid = true;
              database.commit(Ci.nsMsgDBCommitType.kCompressCommit);
              created.push(['Drafts', folder]);
            }
            for (const [name, folder] of created) {
              folder.msgDatabase.forceClosed();
              const file = folder.summaryFile;
              const stream = Cc['@mozilla.org/network/file-input-stream;1']
                .createInstance(Ci.nsIFileInputStream);
              stream.init(file, -1, -1, 0);
              const text = NetUtil.readInputStreamToString(stream, stream.available());
              stream.close();
              const parsed = new MorkParser().parseForImport(text);
              const tables = [...parsed.tables.values()];
              folders[name] = {
                summary: file.path, size: file.fileSize,
                messageTables: tables.filter(table => table.scope ==
                  'ns:msg:db:row:scope:msgs:all' && table.cells.get('k') ==
                  'ns:msg:db:table:kind:msgs').length,
                unifiedTables: tables.filter(table => (table.cells.get('k') || '')
                  .startsWith('mailbox://nobody@smart%20mailboxes/')).length,
                indexedThreads: tables.filter(table => table.cells.get('k') ==
                  'ns:msg:db:table:kind:allthreads').reduce(
                    (total, table) => total + table.rows.length, 0),
                threadTables: tables.filter(table => table.cells.get('k') ==
                  'ns:msg:db:table:kind:thread').length,
                flags: (folder.flags >>> 0).toString(16),
                folderName: folder.name, onlineName: name,
                hierDelim: '2f', boxFlags: '0'};
            }
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, folders};
        """, script_args=[personal, unified, readded, drafts, stale])

    def assert_offline_imap_migration(self, source, expected):
        """Migrate the fabricated summaries, then reuse them twice unchanged."""
        folders = source["folders"]
        names = list(folders)
        self.assertEqual(sorted(names), sorted(expected))
        self.stop_application()
        summaries = {name: Path(folders[name]["summary"]) for name in names}
        for name in names:
            self.assertEqual(folders[name]["size"], summaries[name].stat().st_size)
        originals = {name: summaries[name].read_bytes() for name in names}
        cache = self.write_legacy_cache([{"key": str(summaries[name]), **{
            field: folders[name][field] for field in
            ["flags", "folderName", "onlineName", "hierDelim", "boxFlags"]}}
            for name in names])
        cache_bytes = cache.read_bytes()

        def imported():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                const root = MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder;
                return Object.fromEntries(arguments[1].map(name => {
                  const folder = root.getChildNamed(name);
                  return [name, {
                    personal: !!(folder.flags & Ci.nsMsgFolderFlags.ImapPersonal),
                    messages: [...folder.msgDatabase.enumerateMessages()].map(
                      header => [header.getUint32Property('uidOnServer'),
                                 header.messageId, header.subject]).sort()}];
                }));
            """, script_args=[source["serverKey"], names])

        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        state = imported()
        self.assertEqual(expected, state)
        for name in names:
            self.assertEqual(originals[name], summaries[name].read_bytes())
        self.assertEqual(cache_bytes, cache.read_bytes())
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            repeated = self.selection()
            self.assertEqual(selected["sourceId"], repeated["sourceId"])
            self.assertEqual(selected["record"]["identity"],
                             repeated["record"]["identity"])
            self.assertEqual(state, imported())

    INBOX_MESSAGES = [
        [42, "shape-42-Inbox first@invalid", "Inbox first"],
        [43, "shape-43-Inbox second@invalid", "Inbox second"]]
    SENT_MESSAGES = [
        [1, "shape-1-Sent first@invalid", "Sent first"],
        [2, "shape-2-Sent second@invalid", "Sent second"]]

    def test_migratesInfoOnlyEmptyImapSummary(self):
        source = self.create_legacy_offline_imap_shapes(drafts=True)
        self.assertEqual(0, source["folders"]["Drafts"]["messageTables"])
        self.assert_offline_imap_migration(source, {
            "INBOX": {"personal": False, "messages": self.INBOX_MESSAGES},
            "Drafts": {"personal": False, "messages": []}})

    def test_migratesOfflineImapPersonalNamespaceFlag(self):
        source = self.create_legacy_offline_imap_shapes(personal=True)
        self.assertTrue(int(source["folders"]["INBOX"]["flags"], 16) & 0x80000)
        self.assert_offline_imap_migration(source, {
            "INBOX": {"personal": True, "messages": self.INBOX_MESSAGES}})

    def test_migratesUnifiedHitsAndUnindexedImapThread(self):
        source = self.create_legacy_offline_imap_shapes(unified=True, readded=True)
        folders = source["folders"]
        self.assertEqual(1, folders["INBOX"]["unifiedTables"])
        self.assertEqual(1, folders["Sent"]["unifiedTables"])
        self.assertLess(folders["Sent"]["indexedThreads"], folders["Sent"]["threadTables"])
        self.assert_offline_imap_migration(source, {
            "INBOX": {"personal": False, "messages": self.INBOX_MESSAGES},
            "Sent": {"personal": False, "messages": self.SENT_MESSAGES}})

    def test_leavesStaleOfflineMoveResultOutAndReportsIt(self):
        """Old Thunderbird discards a move result at its next playback and
        Panorama cannot hold one without its source operation. The migration
        leaves it out, counts it, and keeps the original summary. All data is
        fabricated."""
        source = self.create_legacy_offline_imap_shapes(readded=True, stale=True)
        summary = Path(source["folders"]["INBOX"]["summary"])
        self.assertIn(b"shape-ghost@invalid", summary.read_bytes())
        self.assertIn(b"ns:msg:db:row:scope:ops:all", summary.read_bytes())
        self.assert_offline_imap_migration(source, {
            "INBOX": {"personal": False, "messages": self.INBOX_MESSAGES},
            "Sent": {"personal": False, "messages": self.SENT_MESSAGES}})
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        report = json.loads((work / "report.json").read_text(encoding="utf-8"))
        self.assertIn({"code": "stale-move-results", "sources": 1, "count": 1},
                      report["notImported"])

    def test_migratesOrdinaryOfflineImapShapesThenReuses(self):
        """All shapes of the supplied real profile together, all data fabricated."""
        source = self.create_legacy_offline_imap_shapes(
            personal=True, unified=True, readded=True, drafts=True)
        folders = source["folders"]
        self.assertEqual(0, folders["Drafts"]["messageTables"])
        self.assertEqual(1, folders["INBOX"]["unifiedTables"])
        self.assertLess(folders["Sent"]["indexedThreads"], folders["Sent"]["threadTables"])
        self.assertTrue(int(folders["INBOX"]["flags"], 16) & 0x80000)
        self.assert_offline_imap_migration(source, {
            "INBOX": {"personal": True, "messages": self.INBOX_MESSAGES},
            "Sent": {"personal": False, "messages": self.SENT_MESSAGES},
            "Drafts": {"personal": False, "messages": []}})

    def test_migratesImapNamespacesAndNeverLearnedDelimiters(self):
        """A server with namespaces, and folders whose delimiter was never learned.

        All data is fabricated. A copied profile misses its folder-cache entries
        once: the cache then keeps the unknown delimiter while each summary keeps
        its whole online name. A namespace placeholder is never listed at all.
        Thunderbird shows each such folder below the one whose directory holds it.
        """
        self.clean_profile(False)
        source = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            Services.io.offline = true;
            Services.prefs.setBoolPref('network.manage-offline-status', false);
            Services.prefs.setIntPref('offline.startup_state', 2);
            const server = MailServices.accounts.createIncomingServer(
              's526unlisted', 'imap.invalid', 'imap');
            server.setBoolValue('login_at_startup', false);
            server.setBoolValue('download_on_biff', false);
            // What a server with an INBOX prefix and shared mailboxes reports.
            server.setStringValue('namespace.personal', '"INBOX."');
            server.setStringValue('namespace.other_users', '"user."');
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const root = server.rootFolder.QueryInterface(Ci.nsIMsgImapMailFolder);
            const folders = {};
            // [path below the root, cached delimiter, messages]
            for (const [path, cached, count, lookedUp] of [
              ['INBOX', '.', 2],
              ['INBOX/Sent', '.', 1],
              ['INBOX/Kept', '^', 1],
              ['user', '^', 0],
              ['user/team', '^', 0],
              ['user/team/INBOX', '.', 1],
              // Only looked up by the client: Thunderbird hashes this file name.
              ['INBOX/Looked: up', '^', 0, true],
            ]) {
              let folder = server.rootFolder;
              for (const part of path.split('/')) {
                if (!folder.containsChildNamed(part)) {
                  root.createClientSubfolderInfo(path, '.', 0, true);
                }
                folder = folder.getChildNamed(part);
              }
              const onlineName = path.replaceAll('/', '.');
              const imap = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
              imap.onlineName = onlineName;
              imap.hierarchyDelimiter = '.';
              const database = folder.msgDatabase;
              database.dBFolderInfo.setCharProperty('onlineName', onlineName);
              database.dBFolderInfo.setUint32Property('UIDValidity', 526);
              for (let key = 1; key <= count; key++) {
                const header = database.createNewHdrWithSpecificMsgKey(key);
                header.messageId = 'unlisted-' + key + '-' + onlineName + '@invalid';
                header.subject = onlineName + ' ' + key;
                header.setUint32Property('uidOnServer', key);
                database.addNewHdrToDB(header, false);
              }
              if (lookedUp) {
                // The server never listed it: it has no box state at all.
                folder.clearFlag(Ci.nsMsgFolderFlags.ImapBox |
                  Ci.nsMsgFolderFlags.ImapPersonal);
                database.dBFolderInfo.flags = folder.flags;
              }
              if (path == 'user' || path == 'user/team') {
                // A namespace placeholder: its summary word says so, while
                // the box flags kept in the folder cache say nothing.
                folder.setFlag(Ci.nsMsgFolderFlags.ImapNoselect |
                  Ci.nsMsgFolderFlags.ImapOtherUser);
                database.dBFolderInfo.flags = folder.flags;
              }
              database.summaryValid = true;
              database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
              database.forceClosed();
              folders[path] = {
                summary: folder.summaryFile.path, onlineName, delimiter: cached,
                flags: (folder.flags >>> 0).toString(16), folderName: folder.name,
                hierDelim: cached.charCodeAt(0).toString(16), boxFlags: '0',
                messages: count};
            }
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root: server.localPath.path, folders};
        """)
        self.stop_application()
        folders = source["folders"]
        root = Path(source["root"])
        self.assertEqual(root / "INBOX.sbd" / "Kept.msf", Path(folders["INBOX/Kept"]["summary"]))
        self.assertEqual(root / "user.sbd" / "team.sbd" / "INBOX.msf",
                         Path(folders["user/team/INBOX"]["summary"]))
        looked_up = Path(folders["INBOX/Looked: up"]["summary"])
        self.assertEqual(root / "INBOX.sbd", looked_up.parent)
        self.assertNotEqual("Looked: up.msf", looked_up.name)
        self.assertFalse(int(folders["INBOX/Looked: up"]["flags"], 16) & 0x2000)
        self.assertFalse(looked_up.with_suffix("").exists())
        originals = {path: Path(folder["summary"]).read_bytes()
                     for path, folder in folders.items()}
        self.write_legacy_cache([{"key": folder["summary"], **{
            field: folder[field] for field in
            ["flags", "folderName", "onlineName", "hierDelim", "boxFlags"]}}
            for folder in folders.values()])

        def imported():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                const root = MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder;
                const state = {};
                for (const folder of root.descendants) {
                  const imap = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
                  state[decodeURIComponent(folder.URI.slice(root.URI.length + 1))] = {
                    placeholder: !!(folder.flags & Ci.nsMsgFolderFlags.ImapNoselect) &&
                      !!(folder.flags & Ci.nsMsgFolderFlags.ImapOtherUser),
                    box: !!(folder.flags & Ci.nsMsgFolderFlags.ImapBox),
                    onlineName: imap.onlineName,
                    delimiter: imap.hierarchyDelimiter,
                    messages: [...folder.msgDatabase.enumerateMessages()].map(
                      header => header.subject).sort()};
                }
                return state;
            """, script_args=[source["serverKey"]])

        expected = {path: {
            "placeholder": path in ("user", "user/team"),
            "box": path != "INBOX/Looked: up",
            "onlineName": folder["onlineName"], "delimiter": folder["delimiter"],
            "messages": [folder["onlineName"] + " " + str(key)
                         for key in range(1, folder["messages"] + 1)]}
            for path, folder in folders.items()}
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(len(folders), len(selected["record"]["identity"]["imports"]))
        state = imported()
        self.assertEqual(expected, {path: state.get(path) for path in expected})
        for path, folder in folders.items():
            self.assertEqual(originals[path], Path(folder["summary"]).read_bytes())
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            repeated = self.selection()
            self.assertEqual(selected["sourceId"], repeated["sourceId"])
            self.assertEqual(selected["record"]["identity"],
                             repeated["record"]["identity"])
            self.assertEqual(state, imported())

    def test_nativeImapRootSummaryRefusesMessageData(self):
        source = self.create_legacy_imap_source()
        self.stop_application()
        summary = Path(source["summary"])
        root_summary = Path(source["rootSummary"])
        # Use genuine original message-bearing Mork, not invented rows.
        root_summary.write_bytes(summary.read_bytes())
        self.assert_startup_refuses([summary, root_summary], absent=[
            self.profile / "panorama.sqlite",
            self.profile / "panorama-profile.json",
        ])
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        if work.exists():
            self.created_work.add(work)

    def test_rootSummaryOfNoAccountBesideImapRootStaysInPlace(self):
        """A removed account leaves its root summary beside the current ones."""
        source = self.create_legacy_imap_source()
        self.stop_application()
        summary = Path(source["summary"])
        root_summary = Path(source["rootSummary"])
        unknown = root_summary.with_name("unconfigured-root.msf")
        original = root_summary.read_bytes()
        unknown.write_bytes(original)
        self.write_legacy_cache([{"key": str(summary), **{
            name: source[name] for name in
            ["flags", "folderName", "onlineName", "hierDelim", "boxFlags"]}}])
        self.start_same_profile(True)
        selected = self.selection()
        identity = selected["record"]["identity"]
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(1, len(identity["imports"]))
        self.assertEqual(1, len(identity["serverSummaries"]))
        self.assertEqual("server-summary:" + root_summary.relative_to(self.profile).as_posix(),
                         identity["serverSummaries"][0]["sourceId"])
        backup = Path(identity["backup"]["path"])
        self.assertEqual(original, unknown.read_bytes())
        self.assertFalse((backup.parent / "root-0" /
                          unknown.relative_to(self.profile)).exists(),
                         "What no account references is not examined or copied")

    def test_migratesBesideMailOfRemovedAccounts(self):
        """Mail no current account references stays in place and is not imported.

        A removed account leaves its directory, summaries, stores and often its
        whole mail.server branch behind; Thunderbird never opens them again.
        """
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        self.stop_application()
        root = Path(source["root"]).resolve()
        genuine = Path(source["summary"]).read_bytes()
        store = (root / source["name"]).read_bytes()
        removed = self.profile / "ImapMail" / "removed.invalid"
        local = self.profile / "Mail" / "removed-local"
        leftovers = {
            # A removed IMAP account: root summary, folders and an offline store.
            removed.with_name("removed.invalid.msf"): genuine,
            removed / "INBOX.msf": genuine,
            removed / "INBOX": store,
            removed / "Parent.sbd" / "Child.msf": genuine,
            removed / "msgFilterRules.dat": b'version="9"\nlogging="no"\n',
            # A store whose summary is gone, and a summary without its store.
            local / "Archive": store,
            local / "Sent.msf": genuine,
        }
        for path, data in leftovers.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.marionette.instance.profile.set_preferences({
            # The removed account's branch still names its directory.
            "mail.server.serverGone1.type": "imap",
            "mail.server.serverGone1.hostname": "removed.invalid",
            "mail.server.serverGone1.userName": "nobody",
            "mail.server.serverGone1.directory-rel": "[ProfD]ImapMail/removed.invalid",
            # Another leftover branch names the directory a current account uses.
            "mail.server.serverGone2.type": "imap",
            "mail.server.serverGone2.hostname": "reused.invalid",
            "mail.server.serverGone2.userName": "nobody",
            "mail.server.serverGone2.directory-rel":
                "[ProfD]" + root.relative_to(self.profile).as_posix(),
            # A branch from a copied profile names a directory absent here.
            "mail.server.serverGone3.type": "pop3",
            "mail.server.serverGone3.hostname": "copied.invalid",
            "mail.server.serverGone3.userName": "nobody",
            "mail.server.serverGone3.directory":
                str(self.profile.parent / "absent-profile" / "Mail" / "copied.invalid"),
        })
        self.start_same_profile(True)
        selected = self.selection()
        record = selected["record"]
        self.assertEqual("migrated", record["origin"])
        self.assertTrue(record["identity"]["imports"])
        headers = self.assert_message_after_activation(source)

        def folders():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                return MailServices.accounts.allServers.flatMap(server =>
                  [server.rootFolder, ...server.rootFolder.descendants].map(
                    folder => folder.URI));
            """)

        current = folders()
        self.assertFalse([uri for uri in current
                          if "removed" in uri or "reused" in uri or "copied" in uri])
        backup = Path(record["identity"]["backup"]["path"])
        for path, data in leftovers.items():
            self.assertEqual(data, path.read_bytes(), "Unreferenced mail stays in place")
            archived = backup.parent / "root-0" / path.relative_to(self.profile)
            self.assertFalse(archived.exists(), "It is not examined or copied")
        for _ in range(2):
            self.stop_application()
            selector = (self.profile / "panorama-profile.json").read_bytes()
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.assertEqual(headers, self.assert_message_after_activation(source))
            self.assertEqual(current, folders())
            self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
            for path, data in leftovers.items():
                self.assertEqual(data, path.read_bytes())

    def test_unusableOrDirtyJsonCacheNeverRefusesNorFallsBackToMork(self):
        """A folder cache is a hint: old Thunderbird starts with an empty cache
        when the file does not parse and never consults the Mork cache beside
        it; a cell it cannot read simply has no value."""
        for case in ["malformed", "array", "empty", "negativeFlags", "objectName"]:
            self.clean_profile(False)
            source = self.create_legacy_message("mbox")
            self.stop_application()
            summary = Path(source["summary"])
            legacy = self.write_legacy_cache([{"key": str(summary),
                "flags": format(source["flags"] & 0xffffffff, "x"),
                "folderName": "Stale Mork name"}])
            legacy_bytes = legacy.read_bytes()
            cache = self.profile / "folderCache.json"
            raw = {
                "malformed": b'{corrupt JSON',
                "array": b'[]',
                "empty": b'',
                "negativeFlags": json.dumps({str(summary): {"flags": -1}}).encode(),
                "objectName": json.dumps({str(summary): {"folderName": {}}}).encode(),
            }[case]
            cache.write_bytes(raw)
            self.start_same_profile(True)
            selected = self.selection()
            self.assertEqual("migrated", selected["record"]["origin"], case)
            self.assert_message_after_activation(source)
            dirty_cell = case in ("negativeFlags", "objectName")
            self.assertEqual(1 if dirty_cell else 0,
                             len(selected["record"]["identity"]["caches"]), case)
            name = self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                return MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder.getChildNamed(arguments[1]).name;
            """, script_args=[source["serverKey"], source["name"]])
            self.assertEqual(source["name"], name, "The Mork cache is never consulted")
            self.assertEqual(raw, cache.read_bytes())
            self.assertEqual(legacy_bytes, legacy.read_bytes())
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])

    def test_activeMigrationRequiresUnchangedCompleteJournal(self):
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        self.stop_application()
        original_summary = Path(source["summary"]).read_bytes()
        self.start_same_profile(True)
        selected = self.selection()
        self.stop_application()
        record = selected["record"]
        journal = Path(record["identity"]["journalPath"])
        original = journal.read_bytes()
        selector = self.profile / "panorama-profile.json"
        backup = Path(record["identity"]["backup"]["path"])
        saved = journal.with_name("journal-original.json")
        journal.replace(saved)
        self.assert_startup_refuses([saved, selector, backup])
        self.assertFalse(journal.exists(), "Missing journal must remain missing")
        saved.replace(journal)
        for value in [b'{corrupt journal',
                      json.dumps({**json.loads(original), "cancelled": True}).encode(),
                      json.dumps({**json.loads(original), "stage": "validate"}).encode()]:
            journal.write_bytes(value)
            self.assert_startup_refuses([journal, selector, backup])
            self.assertEqual(original_summary, Path(source["summary"]).read_bytes())
        journal.write_bytes(original)
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assert_message_after_activation(source)
        self.assertEqual(original, journal.read_bytes())

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

    def test_emptyNativeJsonCacheInitializesWithoutLegacyBackup(self):
        self.clean_profile(False)
        self.stop_application()
        self.assertFalse(list(self.profile.rglob("*.msf")))
        self.assertFalse(list(self.profile.rglob("*.mab")))
        cache = self.profile / "folderCache.json"
        cache.write_bytes(b"{}")
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        self.assertFalse(work.exists())
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("initialized-empty", selected["record"]["origin"])
        self.assertIsNone(selected["record"]["identity"]["backup"])
        self.assertIsNone(selected["record"]["identity"]["journalPath"])
        self.assertEqual([], selected["record"]["identity"]["caches"])
        self.assertEqual(b"{}", cache.read_bytes())
        self.assertFalse(work.exists(), "Empty JSON requires no invented archive")
        self.stop_application()
        selector = (self.profile / "panorama-profile.json").read_bytes()
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
        self.assertEqual(b"{}", cache.read_bytes())
        self.assertFalse(work.exists())

    @unittest.skipIf(sys.platform == "win32", "POSIX permissions and links")
    def test_indexMigrationNeverReadsMessageStoresOrUnrelatedFiles(self):
        """Bodies stay in place unread; nothing outside the mail data is examined."""
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        self.stop_application()
        root = Path(source["root"]).resolve()
        store = root / source["name"]
        body = store.read_bytes()
        before = store.stat()
        # Not even this process may read the store while it migrates.
        store.chmod(0)
        self.addCleanup(store.chmod, 0o600)
        # Ordinary profile content that is no mail data: a linked directory,
        # a dangling link and a named pipe.
        outside = self.outside_profile()
        (outside / "linked").mkdir()
        (self.profile / "linked-directory").symlink_to(outside / "linked", True)
        (self.profile / "dangling-link").symlink_to(outside / "absent")
        os.mkfifo(self.profile / "named-pipe")
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(0, stat.S_IMODE(store.stat().st_mode))
        store.chmod(0o600)
        after = store.stat()
        self.assertEqual(body, store.read_bytes())
        self.assertEqual((before.st_size, before.st_mtime_ns, before.st_ino),
                         (after.st_size, after.st_mtime_ns, after.st_ino))
        self.assert_message_after_activation(source)
        backup = Path(selected["record"]["identity"]["backup"]["path"])
        manifest = json.loads(backup.read_text())
        entries = {tuple(entry["parts"]): entry for entry in manifest["roots"][0]["entries"]}
        self.assertEqual("in-place", entries[store.relative_to(self.profile).parts]["type"])
        for name in ("linked-directory", "dangling-link", "named-pipe"):
            self.assertNotIn((name,), entries)
        work = backup.parent.parent
        self.assertFalse([path for path in work.rglob("*")
                          if path.is_file() and path.stat().st_size == len(body)
                          and path.read_bytes() == body],
                         "The work directory holds no copy of a message store")
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.assert_message_after_activation(source)

    def test_migratesRawEightBitHeaderCells(self):
        """Old mail has raw 8-bit header bytes that are not UTF-8. Old Thunderbird
        keeps such a cell as bytes; the migration carries it and never refuses.
        All data is fabricated."""
        self.clean_profile(False)
        source = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            const root = new FileUtils.File(PathUtils.join(PathUtils.profileDir,
              'Mail', 's526-raw-cells'));
            root.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            const server = MailServices.accounts.createIncomingServer(
              's526raw', 'localhost', 'none');
            server.localPath = root;
            MailServices.accounts.createAccount().incomingServer = server;
            server.rootFolder.createSubfolder('Old', null);
            const folder = server.rootFolder.getChildNamed('Old')
              .QueryInterface(Ci.nsIMsgLocalMailFolder);
            // Each character below 256 is written as that one byte.
            folder.addMessage(
              'From - Thu Nov 05 00:00:00 2026\r\n' +
              'Message-ID: <raw-cells-s526@invalid>\r\n' +
              'From: Andr\u00e9 Source <source@example.invalid>\r\n' +
              'To: destination@example.invalid\r\n' +
              'Subject: caf\u00e9 raw \u00fc\u00f1\r\n' +
              'Date: Thu, 5 Nov 2026 00:00:00 +0000\r\n\r\n' +
              'Body.\r\n');
            folder.addMessage(
              'From - Thu Nov 05 00:00:01 2026\r\n' +
              'Message-ID: <plain-s526@invalid>\r\n' +
              'From: source@example.invalid\r\n' +
              'Subject: Plain neighbour\r\n' +
              'Date: Thu, 5 Nov 2026 00:00:01 +0000\r\n\r\n' +
              'Body.\r\n');
            folder.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, summary: folder.summaryFile.path};
        """)
        self.stop_application()
        summary = Path(source["summary"])
        original = summary.read_bytes()
        self.assertTrue(b"caf$E9" in original or b"caf\xe9" in original,
                        "The fixture summary holds a cell that is not UTF-8")

        def messages():
            return self.marionette.execute_script("""
                const { MailServices } = ChromeUtils.importESModule(
                  'resource:///modules/MailServices.sys.mjs');
                const folder = MailServices.accounts.getIncomingServer(arguments[0])
                  .rootFolder.getChildNamed('Old');
                return [...folder.msgDatabase.enumerateMessages()].map(header => ({
                  messageId: header.messageId, subject: header.subject,
                  author: header.author})).sort(
                    (a, b) => a.messageId < b.messageId ? -1 : 1);
            """, script_args=[source["serverKey"]])

        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        state = messages()
        self.assertEqual(["plain-s526@invalid", "raw-cells-s526@invalid"],
                         [message["messageId"] for message in state])
        self.assertEqual("Plain neighbour", state[0]["subject"])
        self.assertTrue(state[1]["subject"].startswith("caf"))
        self.assertIn(" raw ", state[1]["subject"])
        self.assertIn("Source", state[1]["author"])
        self.assertEqual(original, summary.read_bytes())
        for _ in range(2):
            self.stop_application()
            self.start_same_profile(True)
            self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
            self.assertEqual(state, messages())

    def test_genuine_mork_mbox_migration_and_reuse(self):
        self.assert_mork_migration("mbox")

    def test_genuine_mork_maildir_migration_and_reuse(self):
        self.assert_mork_migration("maildir")

    def test_genuine_pop3_mbox_migration_and_reuse(self):
        """POP3 folders keep an ordinary local store under their own server."""
        self.assert_mork_migration("mbox", "pop3")

    def test_genuine_pop3_maildir_migration_and_reuse(self):
        self.assert_mork_migration("maildir", "pop3")

    def test_genuine_rss_mbox_migration_and_reuse(self):
        """Feed folders keep an ordinary local store under their own server."""
        self.assert_mork_migration("mbox", "rss")

    def test_genuine_nntp_metadata_only_migration_and_reuse(self):
        """A subscribed newsgroup migrates without any downloaded article body."""
        self.assert_mork_migration("mbox", "nntp")

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

    def test_safe_external_root_migration_and_reuse(self):
        """An ordinary Local Directory outside the profile is its own backup root."""
        self.clean_profile(False)
        external = tempfile.TemporaryDirectory(prefix="s526-external-root-")
        self.addCleanup(external.cleanup)
        root = Path(external.name).resolve() / "account"
        source = self.create_legacy_message("mbox", root=root)
        self.stop_application()
        before = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
        self.assertIn(Path(source["summary"]).resolve(), before)
        self.start_same_profile(True)
        selected = self.selection()
        record = selected["record"]
        self.assertEqual("migrated", record["origin"])
        headers = self.assert_message_after_activation(source)
        backup = Path(record["identity"]["backup"]["path"])
        manifest = json.loads(backup.read_text())
        sources = [Path(item["source"]).resolve() for item in manifest["roots"]]
        self.assertEqual([self.profile, root], sources)
        self.assertTrue(self.assert_index_backup(manifest, backup.parent, 1, before))
        journal = json.loads(Path(record["identity"]["journalPath"]).read_text())
        self.assertEqual([str(root)], [str(Path(p).resolve()) for p in journal["mailPaths"]])
        self.stop_application()
        selector = (self.profile / "panorama-profile.json").read_bytes()
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(headers, self.assert_message_after_activation(source))
        self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())

    @unittest.skipUnless(sys.platform == "win32", "Windows case-insensitive spelling")
    def test_windows_case_alias_server_root_migrates(self):
        """A server directory spelled in another letter case is the same directory."""
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        alias = str(Path(source["root"])).upper()
        self.assertNotEqual(source["root"], alias)
        self.marionette.execute_script("""
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            Services.prefs.clearUserPref('mail.server.' + arguments[0] + '.directory-rel');
            Services.prefs.setComplexValue('mail.server.' + arguments[0] + '.directory',
              Ci.nsIFile, new FileUtils.File(arguments[1]));
            Services.prefs.savePrefFile(null);
        """, script_args=[source["serverKey"], alias])
        self.stop_application()
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        headers = self.assert_message_after_activation(source)
        respelled = self.marionette.execute_script("""
            return Services.prefs.getComplexValue(
              'mail.server.' + arguments[0] + '.directory', Ci.nsIFile).path;
        """, script_args=[source["serverKey"]])
        self.assertEqual(source["root"], respelled)
        self.stop_application()
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])
        self.assertEqual(headers, self.assert_message_after_activation(source))

    def test_external_root_containing_profile_refuses(self):
        """A mail root that contains the profile has ambiguous ownership."""
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        self.marionette.execute_script("""
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            Services.prefs.clearUserPref('mail.server.' + arguments[0] + '.directory-rel');
            Services.prefs.setComplexValue('mail.server.' + arguments[0] + '.directory',
              Ci.nsIFile, new FileUtils.File(arguments[1]));
            Services.prefs.savePrefFile(null);
        """, script_args=[source["serverKey"], str(self.profile.parent)])
        self.stop_application()
        self.assert_startup_refuses(
            [Path(source["summary"])],
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
            self.marionette.instance.profile.set_preferences({"mail.panorama.enabled": enabled})
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
        self.marionette.instance.profile.set_preferences({"mail.panorama.enabled": True})
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
        leftover = b'{"interrupted":"a journal no migration finished"}\n'
        journal.write_bytes(leftover)
        # Work without a selector or a database is an attempt that never
        # activated. It is never read as progress or resumed: startup sets it
        # aside whole and proceeds from the unchanged profile.
        self.start_same_profile(True)
        fresh = self.selection()
        self.assertNotEqual(selected["sourceId"], fresh["sourceId"])
        aside = work / "incomplete-1"
        self.assertEqual(["journal.json"], [path.name for path in aside.iterdir()])
        self.assertEqual(leftover, (aside / "journal.json").read_bytes())
        self.assertFalse((work / "incomplete-2").exists())

    def tearDown(self):
        try:
            self.stop_application()
            self.marionette.instance.app_args = self.original_args
            self.marionette.instance.restart(prefs=self.original_prefs, clean=True)
            self.marionette.raise_for_port(timeout=self.marionette.startup_timeout)
            self.marionette.start_session()
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.marionette.execute_script("""
                const service = Cc['@mozilla.org/toolkit/profile-service;1']
                  .getService(Ci.nsIToolkitProfileService);
                for (const name of arguments[0]) {
                  service.getProfileByName(name).remove(false);
                }
                service.flush();
            """, script_args=[sorted(self.registered_profiles)])
            for work in self.created_work:
                # Remove only this disposable test's exact outside-profile archive.
                self.assertTrue(work.name.startswith("panorama-migration-"))
                shutil.rmtree(work)
        finally:
            super().tearDown()


    def restore_exit(self, flags=(), expected=0):
        """Run a real command-only/restore-only process without a Marionette session."""
        self.stop_application()
        self.marionette.instance.app_args = self.original_args + list(flags)
        self.marionette.instance.start()
        # A restore process copies, verifies and settles every approved root
        # with write-through IO before it exits; that is not a startup. A
        # native restore with retained dependencies takes about 22 minutes on
        # Windows debug CI while still progressing per file. Report each wait
        # interval: the harness stops a test that is silent for 1000 seconds.
        bound = self.marionette.startup_timeout * 20
        waited, code = 0, None
        while code is None and waited < bound:
            interval = min(300, bound - waited)
            code = self.marionette.instance.runner.wait(timeout=interval)
            waited += interval
            if code is None:
                self.logger.info(f"Restore process still running after {waited}s")
        self.assertEqual(expected, code, "Restore processes must settle and exit")
        self.marionette.instance.app_args = self.original_args

    def restore_request_path(self):
        """Return only this selected disposable profile's fixed request path."""
        return self.profile.parent / ("panorama-migration-" + self.profile.name) / "restore.json"

    def restore_result(self):
        """Read only the actual settled native generation after its process exits."""
        pending = self.restore_request_path()
        self.assertFalse(pending.exists(), "Settlement removes the pending request")
        raw = pending.with_name("restore-current.json").read_bytes()
        result = json.loads(raw)
        self.assertEqual(1, result["nativeSettlement"])
        generation = result["progress"]["generation"]
        self.assertGreater(generation, 0)
        audit = pending.with_name(f'restore-{result["operationId"]}-{generation}.complete.json')
        self.assertEqual(raw, audit.read_bytes(), "Current index binds the exact immutable audit")
        return result

    def cleanup_restore_staging(self, staging):
        """Remove only the exact staging directory created for this test's request."""
        self.assertEqual(self.profile.parent.resolve(), staging.parent.resolve())
        self.assertTrue(staging.name.startswith("panorama-restore-"))
        self.assertFalse(staging.is_symlink())
        if staging.exists():
            shutil.rmtree(staging)

    def approve_restore(self, backup):
        """Approve every literal manifest root through the implemented user command."""
        manifest = json.loads((backup / "manifest.json").read_text())
        flags = ["--panorama-restore", str(backup)]
        for root in manifest["roots"]:
            flags += ["--panorama-restore-approve", root["source"]]
        work = self.restore_request_path().parent
        self.created_work.add(work)
        self.restore_exit(flags)
        request = json.loads(self.restore_request_path().read_text())
        self.assertEqual("restore", request["mode"])
        self.assertEqual([root["source"] for root in manifest["roots"]],
                         [root["original"] for root in request["approvedRoots"]])
        self.assertNotIn("progress", request, "Consent is not cutover")
        staging = Path(request["stagingParent"])
        self.assertEqual(self.profile.parent.resolve(), staging.parent.resolve())
        self.assertTrue(staging.name.startswith("panorama-restore-"))
        self.addCleanup(self.cleanup_restore_staging, staging)
        return request

    def external_restore_point(self):
        """Back up real legacy stores/book before writers, then retain newer data."""
        self.clean_profile(False)
        mbox_source = self.create_legacy_message("mbox")
        maildir_source = self.create_legacy_message("maildir", user="s527-maildir")
        self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const book = MailServices.ab.getDirectory('jsaddrbook://abook.sqlite');
            const card = Cc['@mozilla.org/addressbook/cardproperty;1']
              .createInstance(Ci.nsIAbCard);
            card.displayName = 'Original S527 contact';
            book.addCard(card);
        """)
        temporary = tempfile.TemporaryDirectory(prefix="s527-whole-restore-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        self.stop_application()
        external = []
        prefs = {}
        for name, source in [("mbox", mbox_source), ("maildir", maildir_source)]:
            destination = root / name
            shutil.copytree(source["root"], destination)
            external.append(destination)
            prefs[f'mail.server.{source["serverKey"]}.directory'] = str(destination)
            prefs[f'mail.server.{source["serverKey"]}.directory-rel'] = (
                "[ProfD]" + Path(os.path.relpath(destination, self.profile)).as_posix()
            )
        self.marionette.instance.profile.set_preferences(prefs)
        markers = [self.profile / "s527-original", *(path / "s527-original" for path in external)]
        for marker in markers:
            marker.write_bytes(b"original complete restore bytes\n")
        backup = root / "archive"
        self.marionette.instance.app_args = self.original_args + ["--panorama-backup", str(backup)]
        self.start_same_profile(False)
        self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const card = Cc['@mozilla.org/addressbook/cardproperty;1']
              .createInstance(Ci.nsIAbCard);
            card.displayName = 'Newer retained S527 contact';
            MailServices.ab.getDirectory('jsaddrbook://abook.sqlite').addCard(card);
        """)
        self.stop_application()
        self.marionette.instance.app_args = self.original_args
        manifest_bytes = (backup / "manifest.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertTrue(manifest["complete"])
        self.assertEqual({str(self.profile), *(str(path) for path in external)},
                         {item["source"] for item in manifest["roots"]})
        for marker in markers:
            marker.write_bytes(b"newer retained restore bytes\n")
        return backup, markers, manifest_bytes

    def assert_restored_contacts(self, newer=False):
        """Read the restored real address book through its ordinary public service."""
        names = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            return Array.from(MailServices.ab.getDirectory(
              'jsaddrbook://abook.sqlite').childCards, card => card.displayName);
        """)
        self.assertIn("Original S527 contact", names)
        self.assertEqual(newer, "Newer retained S527 contact" in names)

    def test_approvedRestoreSameProfileWithExternalStores(self):
        backup, markers, archive = self.external_restore_point()
        request = self.approve_restore(backup)
        for marker in markers:
            self.assertEqual(b"newer retained restore bytes\n", marker.read_bytes())
        self.restore_exit()
        result = self.restore_result()
        self.assertEqual(request["operationId"], result["operationId"])
        self.assertEqual("restored", result["progress"]["outcome"])
        self.assertEqual(archive, (backup / "manifest.json").read_bytes())
        for marker in markers:
            self.assertEqual(b"original complete restore bytes\n", marker.read_bytes())
        current = self.restore_request_path().with_name("restore-current.json")
        audit = current.read_bytes()
        current.write_bytes(audit + b" ")
        self.restore_exit(expected=5)
        self.assertEqual(audit + b" ", current.read_bytes(), "Foreign index is retained")
        current.write_bytes(audit)
        self.start_same_profile(False)
        self.assert_restored_contacts()
        receipt = current.with_name(
            f'restore-{result["operationId"]}-{result["progress"]["generation"]}.ordinary.json'
        )
        self.assertEqual(audit, receipt.read_bytes(), "Actual ordinary settlement is durable")
        self.stop_application()
        self.start_same_profile(False)
        self.assert_restored_contacts()
        self.assertFalse((self.profile / "panorama.sqlite").exists())
        self.assertFalse((self.profile / "panorama-profile.json").exists())

    def test_restoreRollbackRetainsAllNewerRoots(self):
        backup, markers, archive = self.external_restore_point()
        request = self.approve_restore(backup)
        later = [marker.parent / "s527-created-after-consent" for marker in markers]
        for child in later:
            child.write_bytes(b"new child after consent, before native entry\n")
        prefs = self.profile / "prefs.js"
        newer_prefs = prefs.read_bytes() + b'\nuser_pref("s527.retainedNewer", true);\n'
        prefs.write_bytes(newer_prefs)
        self.restore_exit()
        for child in later:
            self.assertFalse(child.exists(), "Restored roots exclude later children")
        self.assertEqual("restored", self.restore_result()["progress"]["outcome"])
        offline = backup.with_name("archive-offline")
        backup.rename(offline)
        try:
            self.restore_exit(["--panorama-restore-rollback"])
            pending = json.loads(self.restore_request_path().read_text())
            self.assertEqual(request["operationId"], pending["operationId"])
            self.restore_exit()
            result = self.restore_result()
        finally:
            offline.rename(backup)
        self.assertEqual("rolled-back", result["progress"]["outcome"])
        self.assertEqual(b"original complete restore bytes\n", (next((Path(request["stagingParent"]) / f'restore-{request["operationId"]}').glob("newer-0-*")) / "s527-original").read_bytes())
        for child in later:
            self.assertEqual(b"new child after consent, before native entry\n", child.read_bytes())
        self.assertIn(b'user_pref("s527.retainedNewer", true);', prefs.read_bytes())
        for marker in markers:
            self.assertEqual(b"newer retained restore bytes\n", marker.read_bytes())
        self.assertEqual(archive, (backup / "manifest.json").read_bytes())
        self.start_same_profile(False)
        self.assert_restored_contacts(newer=True)

    def test_failedRestoreGuardBlocksDisabledStartupAndRetries(self):
        backup, markers, archive = self.external_restore_point()
        request = self.approve_restore(backup)
        manifest = json.loads(archive)
        archived = backup / manifest["roots"][0]["directory"] / "s527-original"
        saved = archived.read_bytes()
        saved_stat = archived.stat()
        archived.write_bytes(b"changed after explicit consent\n")
        self.restore_exit(expected=5)
        self.assertEqual(request["operationId"], json.loads(self.restore_request_path().read_text())["operationId"])
        for marker in markers:
            self.assertEqual(b"newer retained restore bytes\n", marker.read_bytes())
        archived.write_bytes(saved)
        os.utime(archived, ns=(saved_stat.st_atime_ns, saved_stat.st_mtime_ns))
        self.restore_exit(["--panorama-restore-retry"])
        self.restore_exit()
        self.assertEqual("restored", self.restore_result()["progress"]["outcome"])
        self.assertEqual(archive, (backup / "manifest.json").read_bytes())
        self.start_same_profile(False)
        self.assert_restored_contacts()

    def test_samePathRestorePreservesGenuineNativeReceipts(self):
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        legacy_temporary = tempfile.TemporaryDirectory(prefix="s527-before-optin-")
        self.addCleanup(legacy_temporary.cleanup)
        legacy_backup = Path(legacy_temporary.name).resolve() / "archive"
        self.stop_application()
        self.marionette.instance.app_args = self.original_args + [
            "--panorama-backup", str(legacy_backup)
        ]
        self.start_same_profile(False)
        self.stop_application()
        self.marionette.instance.app_args = self.original_args
        legacy_request = self.approve_restore(legacy_backup)
        self.restore_exit()
        self.assertEqual(legacy_request["operationId"], self.restore_result()["operationId"])
        self.start_same_profile(False)
        self.assertFalse((self.profile / "panorama.sqlite").exists())
        self.stop_application()
        # Opt-in may reuse only native-authenticated restore work, retaining its audit.
        self.start_same_profile(True)
        before = self.selection()
        original = self.assert_message_after_activation(source)
        selector = (self.profile / "panorama-profile.json").read_bytes()
        journal = Path(before["record"]["identity"]["journalPath"])
        journal_bytes = journal.read_bytes()
        temporary = tempfile.TemporaryDirectory(prefix="s527-native-restore-")
        self.addCleanup(temporary.cleanup)
        backup = Path(temporary.name).resolve() / "archive"
        self.stop_application()
        self.marionette.instance.app_args = self.original_args + ["--panorama-backup", str(backup)]
        self.start_same_profile(True)
        self.stop_application()
        self.marionette.instance.app_args = self.original_args
        request = self.approve_restore(backup)
        self.assertTrue(request["dependencies"], "Retained sibling metadata must be bound")
        self.restore_exit()
        self.assertEqual("restored", self.restore_result()["progress"]["outcome"])
        self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
        self.assertEqual(journal_bytes, journal.read_bytes())
        self.start_same_profile(True)
        self.assertEqual(before, self.selection())
        self.assertEqual(original, self.assert_message_after_activation(source))
        self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
        self.assertEqual(journal_bytes, journal.read_bytes())

    # S7-15 trial: interrupt the real pref-driven process at its existing
    # durable boundaries, then restart it. POSIX kernel limits/FIFOs/signals only;
    # no product hook, polling loop or custom harness.

    def largest_file_limit(self, roots):
        """Exceed every existing regular file the process may copy before the cut."""
        largest = 0
        for root in roots:
            for path in Path(root).rglob("*"):
                if path.is_file() and not path.is_symlink():
                    largest = max(largest, path.stat().st_size)
        return largest + 1024 * 1024

    def write_large_file(self, path, size):
        """Write deterministic bytes larger than the limit; return their digest."""
        block = hashlib.sha256(path.name.encode()).digest() * 2048
        digest = hashlib.sha256()
        with open(path, "wb") as output:
            written = 0
            while written < size:
                chunk = block[: min(len(block), size - written)]
                output.write(chunk)
                digest.update(chunk)
                written += len(chunk)
        return digest.hexdigest()

    def file_digests(self, root):
        """Independently hash every regular file in a physical tree."""
        return {
            path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(Path(root).rglob("*"))
            if path.is_file() and not path.is_symlink()
        }

    def assert_cut_copy(self, parent, source, limit):
        """Prove the kernel stopped the real copy of `source` at exactly `limit`."""
        cut = [path for path in Path(parent).rglob("*")
               if path.is_file() and not path.is_symlink() and path.stat().st_size == limit]
        self.assertEqual(1, len(cut), "Exactly one copy stopped at the limit")
        with open(source, "rb") as original:
            self.assertEqual(original.read(limit), cut[0].read_bytes(),
                             "The stopped write is the oversized input's own copy")
        return cut[0]

    def start_with_file_size_limit(self, limit):
        """Start the stopped process so the kernel stops its first write past limit."""
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
        self.assertTrue(hard == resource.RLIM_INFINITY or hard > limit)
        # The child inherits the limit; mozprocess restores default SIGXFSZ.
        resource.setrlimit(resource.RLIMIT_FSIZE, (limit, hard))
        try:
            self.marionette.instance.start()
        finally:
            resource.setrlimit(resource.RLIMIT_FSIZE, (soft, hard))
        code = self.marionette.instance.runner.wait(
            timeout=self.marionette.startup_timeout
        )
        self.assertEqual(-signal.SIGXFSZ, code,
                         "The kernel must stop the real copy at its file-size limit")

    def create_legacy_folders(self, count):
        """Write genuine Mork folders, one message each, through the legacy API."""
        result = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { FileUtils } = ChromeUtils.importESModule(
              'resource://gre/modules/FileUtils.sys.mjs');
            const root = PathUtils.join(PathUtils.profileDir, 'Mail',
              's715-' + Services.uuid.generateUUID().toString());
            const file = new FileUtils.File(root);
            if (!file.parent.exists()) {
              file.parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            }
            file.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
            const server = MailServices.accounts.createIncomingServer(
              's715', 'localhost', 'none');
            server.setStringValue('storeContractID',
              '@mozilla.org/msgstore/berkeleystore;1');
            server.localPath = file;
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const folders = [];
            for (let i = 0; i < arguments[0]; i++) {
              const name = 'S715 committed unit ' + i;
              server.rootFolder.createSubfolder(name, null);
              const folder = server.rootFolder.getChildNamed(name)
                .QueryInterface(Ci.nsIMsgLocalMailFolder);
              const header = folder.addMessage(
                'From - Thu Nov 05 00:00:00 2026\r\n' +
                'Message-ID: <s715-unit-' + i + '@invalid>\r\n' +
                'From: source@example.invalid\r\n' +
                'Subject: Committed unit ' + i + '\r\n' +
                'Date: Thu, 5 Nov 2026 00:00:00 +0000\r\n\r\n' +
                'Preserved unit body.\r\n');
              folder.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
              folders.push({name, summary: folder.summaryFile.path,
                key: header.messageKey});
            }
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root, folders};
        """, script_args=[count])
        self.assertEqual(count, len(result["folders"]))
        return result

    def fail_selector_publication(self):
        """Fail the real final selector write at its atomic temporary path."""
        # Preparation writes the selector directly; only the final active
        # publication uses this temporary path. A directory is an ordinary
        # inventory entry, so migration reaches the actual cutover write.
        blocker = self.profile / "panorama-profile.json.tmp"
        blocker.mkdir(mode=0o700)
        self.marionette.instance.profile.set_preferences({"mail.panorama.enabled": True})
        self.marionette.instance.start()
        code = self.marionette.instance.runner.wait(
            timeout=self.marionette.startup_timeout
        )
        self.assertEqual(5, code, "An interrupted cutover exits with NS_ERROR_FAILURE")
        self.assertEqual([], list(blocker.iterdir()))
        blocker.rmdir()

    def native_unit_mappings(self):
        """Read committed native receipts from a copy, never the retained files."""
        copy = tempfile.TemporaryDirectory(prefix="s715-native-read-")
        self.addCleanup(copy.cleanup)
        for suffix in ("", "-wal", "-shm"):
            path = self.profile / ("panorama.sqlite" + suffix)
            if path.exists():
                shutil.copyfile(path, Path(copy.name) / path.name)
        connection = sqlite3.connect(Path(copy.name) / "panorama.sqlite")
        try:
            receipts = connection.execute(
                "SELECT token, sourceId, folderId, messageCount "
                "FROM folder_import_receipts"
            ).fetchall()
            mappings = {}
            for token, source_id, folder_id, count in receipts:
                keys = connection.execute(
                    "SELECT sourceKey, destinationKey FROM folder_import_keys "
                    "WHERE token=? ORDER BY sourceKey", (token,)
                ).fetchall()
                messages = connection.execute(
                    "SELECT COUNT(*) FROM messages WHERE folderId=?", (folder_id,)
                ).fetchone()[0]
                mappings[source_id] = (folder_id, count, keys, messages)
        finally:
            connection.close()
        self.assertEqual(len(receipts), len(mappings), "One receipt per source")
        return mappings

    @unittest.skipUnless(sys.platform.startswith("linux"), "POSIX file-size limit")
    def test_interruptedStartupBackupIsSetAsideAndMigrationRetried(self):
        """S7-15.1: cut the real opt-in startup copy; restart never accepts it
        and completes a new migration unaided."""
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        self.stop_application()
        limit = self.largest_file_limit([self.profile])
        # An index backup copies account files beside the stores, never a store.
        large = Path(source["root"]).resolve() / "filterlog.html"
        digest = self.write_large_file(large, 4 * limit)
        originals = {path: path.read_bytes()
                     for path in Path(source["root"]).rglob("*") if path.is_file()}
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        self.assertFalse(work.exists())
        self.created_work.add(work)
        self.marionette.instance.profile.set_preferences({"mail.panorama.enabled": True})
        self.start_with_file_size_limit(limit)

        backup = work / "backup"
        manifest_bytes = (backup / "manifest.json").read_bytes()
        manifest = json.loads(manifest_bytes)
        self.assertIs(False, manifest["complete"], "An interrupted copy is never complete")
        profile_root = next(root for root in manifest["roots"]
                            if Path(root["source"]).resolve() == self.profile)
        installed = backup / profile_root["directory"] / large.relative_to(self.profile)
        self.assertFalse(installed.exists(),
                         "The cut file is never installed in the archive")
        self.assert_cut_copy(backup / "scratch", large, limit)
        for absent in (work / "journal.json", self.profile / "panorama-profile.json",
                       self.profile / "panorama.sqlite"):
            self.assertFalse(absent.exists(), "No migration state follows a partial copy")
        self.assertEqual(digest, hashlib.sha256(large.read_bytes()).hexdigest())
        for path, contents in originals.items():
            self.assertEqual(contents, path.read_bytes())

        # Partial work without a selector never activated. Restart never
        # accepts or resumes the incomplete archive: it sets it aside whole and
        # migrates again, unaided, from the unchanged original.
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        aside = work / "incomplete-1" / "backup"
        self.assertEqual(manifest_bytes, (aside / "manifest.json").read_bytes())
        self.assertFalse(
            (aside / profile_root["directory"] / large.relative_to(self.profile)).exists())
        self.assertIs(True, json.loads((backup / "manifest.json").read_bytes())["complete"])
        self.assertEqual(digest, hashlib.sha256(large.read_bytes()).hexdigest())
        for path, contents in originals.items():
            self.assertEqual(contents, path.read_bytes(), path.name)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux process lifecycle")
    def test_interruptedActivationCutoverNeverExposesActiveState(self):
        """S7-15.2/S7-15.3: fail the final publication after committed units."""
        self.clean_profile(False)
        source = self.create_legacy_folders(40)
        self.stop_application()
        summaries = [Path(folder["summary"]) for folder in source["folders"]]
        originals = {path: path.read_bytes()
                     for path in Path(source["root"]).rglob("*") if path.is_file()}
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        self.created_work.add(work)
        self.fail_selector_publication()

        selector = self.profile / "panorama-profile.json"
        database = self.profile / "panorama.sqlite"
        record = json.loads(selector.read_bytes())
        self.assertEqual("prepared", record["state"], "Cutover never published active")
        journal = Path(record["identity"]["journalPath"])
        journal_state = json.loads(journal.read_bytes())
        self.assertEqual("complete", journal_state["stage"],
                         "Validation and activation finished before the failed publication")
        self.assertIsNotNone(journal_state["lastError"], "The interrupted cutover is recorded")
        mappings = self.native_unit_mappings()
        # Default local folders commit their own empty units beside these.
        for folder_id, count, keys, messages in mappings.values():
            self.assertEqual((count, count), (len(keys), messages),
                             "Each committed unit keeps exactly one physical mapping")
        self.assertEqual(len(summaries), sum(value[1] for value in mappings.values()))
        self.assertEqual(len(summaries), len([v for v in mappings.values() if v[1] == 1]),
                         "Every original message has one committed unit mapping")
        self.assertEqual(len(mappings), len({value[0] for value in mappings.values()}))
        for path, contents in originals.items():
            self.assertEqual(contents, path.read_bytes())

        # The attempt never activated, so nothing the old application reads
        # changed. The next start sets it aside whole (candidate database,
        # selector and journal, byte for byte) and migrates again unaided.
        attempt = {path: path.read_bytes() for path in (selector, journal, database)}
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        aside = work / "incomplete-1"
        for path, contents in attempt.items():
            self.assertEqual(contents, (aside / path.name).read_bytes(), path.name)
        self.assertEqual(
            "prepared",
            json.loads((aside / "panorama-profile.json").read_bytes())["state"])
        self.assertFalse((work / "incomplete-2").exists())
        self.assertNotEqual(
            attempt[selector], selector.read_bytes(), "A new selection, not the old one")
        for path, contents in originals.items():
            self.assertEqual(contents, path.read_bytes(), path.name)
        self.stop_application()
        again = self.native_unit_mappings()
        self.assertEqual(sorted(mappings), sorted(again))
        self.assertEqual(len(summaries), sum(value[1] for value in again.values()))
        self.start_same_profile(True)
        self.assertEqual(selected["sourceId"], self.selection()["sourceId"])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux process lifecycle")
    def test_neverActivatedAttemptRetriesTwicePerBuildThenStops(self):
        """One build migrates again twice on its own. Its third attempt stays
        in place and startup stops; with the backend switched off the attempt
        is set aside and the old application starts from its unchanged
        profile. All data is fabricated."""
        self.clean_profile(False)
        source = self.create_legacy_folders(3)
        self.stop_application()
        summaries = [Path(folder["summary"]) for folder in source["folders"]]
        work = self.profile.parent / ("panorama-migration-" + self.profile.name)
        self.created_work.add(work)
        selector = self.profile / "panorama-profile.json"
        database = self.profile / "panorama.sqlite"
        for attempt in (1, 2, 3):
            self.fail_selector_publication()
            self.assertEqual("prepared", json.loads(selector.read_bytes())["state"])
            self.assertEqual(
                ["incomplete-%d" % number for number in range(1, attempt)],
                sorted(path.name for path in work.glob("incomplete-*")))
        journal = work / "journal.json"
        self.assert_startup_refuses([selector, journal, database, *summaries],
                                    absent=[work / "incomplete-3"])
        third = {path: path.read_bytes() for path in (selector, journal, database)}

        self.start_same_profile(False)
        for path, contents in third.items():
            self.assertFalse(path.exists(), path.name)
            self.assertEqual(contents, (work / "incomplete-3" / path.name).read_bytes())
        folders = self.marionette.execute_script("""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            return MailServices.accounts.getIncomingServer(arguments[0])
              .rootFolder.subFolders.map(folder => folder.getTotalMessages(false));
        """, script_args=[source["serverKey"]])
        self.assertEqual(len(summaries), sum(folders))
        self.stop_application()

        # Switching the backend on again is the user's own new attempt.
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertFalse((work / "incomplete-4").exists())
        self.stop_application()
        self.assertEqual(len(summaries),
                         sum(value[1] for value in self.native_unit_mappings().values()))

    @unittest.skipUnless(sys.platform.startswith("linux"), "POSIX file-size limit")
    def test_interruptedRestoreCopyClaimsNoCompletion(self):
        """S7-15.4: cut the real native restore copy; never claim completion."""
        backup, markers, archive = self.external_restore_point()
        external = [marker.parent for marker in markers[1:]]
        request = self.approve_restore(backup)
        self.marionette.instance.app_args = self.original_args
        # Closed-writer entry captures children created after the request.
        limit = self.largest_file_limit([self.profile, backup, *external])
        newer = self.profile / "s715-newer-before-restore"
        digest = self.write_large_file(newer, 4 * limit)
        archived = self.file_digests(backup)
        self.start_with_file_size_limit(limit)

        self.assert_cut_copy(request["stagingParent"], newer, limit)
        pending = self.restore_request_path()
        interrupted = json.loads(pending.read_text())
        self.assertEqual(request["operationId"], interrupted["operationId"])
        self.assertIn("progress", interrupted, "Progress precedes the first custody copy")
        self.assertFalse(pending.with_name("restore-current.json").exists())
        self.assertFalse(list(pending.parent.glob("restore-*.complete.json")))
        self.assertEqual(archive, (backup / "manifest.json").read_bytes())
        self.assertEqual(archived, self.file_digests(backup))
        for marker in markers:
            self.assertEqual(b"newer retained restore bytes\n", marker.read_bytes())
        self.assertEqual(digest, hashlib.sha256(newer.read_bytes()).hexdigest())

        self.stop_application()
        self.marionette.instance.start()
        code = self.marionette.instance.runner.wait(timeout=self.marionette.startup_timeout)
        self.assertEqual(5, code, "Unfinished interrupted work blocks ordinary startup")
        self.assertEqual(request["operationId"], json.loads(pending.read_text())["operationId"])
        self.assertFalse(pending.with_name("restore-current.json").exists())
        for marker in markers:
            self.assertEqual(b"newer retained restore bytes\n", marker.read_bytes())
        # The documented exact-operation retry, then one ordinary settlement.
        self.restore_exit(["--panorama-restore-retry"])
        self.assertTrue(list(pending.parent.glob(
            f'restore-{request["operationId"]}-*.failed.json')))
        self.restore_exit()
        result = self.restore_result()
        self.assertEqual(request["operationId"], result["operationId"])
        self.assertEqual("restored", result["progress"]["outcome"])
        for marker in markers:
            self.assertEqual(b"original complete restore bytes\n", marker.read_bytes())
        self.assertFalse(newer.exists(), "Restored roots exclude data newer than the archive")
        self.assertEqual(archive, (backup / "manifest.json").read_bytes())
        self.assertEqual(archived, self.file_digests(backup))
        self.start_same_profile(False)
        self.assert_restored_contacts()
