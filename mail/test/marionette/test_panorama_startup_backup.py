# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import hashlib
import json
import os
import shutil
import signal
import sqlite3
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

    def create_legacy_message(self, store, name="Inbox", user="s526"):
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
              arguments[2], 'localhost', 'none');
            server.setStringValue('storeContractID', arguments[0] === 'maildir'
              ? '@mozilla.org/msgstore/maildirstore;1'
              : '@mozilla.org/msgstore/berkeleystore;1');
            server.localPath = file;
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const parent = server.rootFolder;
            parent.createSubfolder(arguments[1], null);
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
              name: folder.name, flags: folder.msgDatabase.dBFolderInfo.flags};
        """, script_args=[store, name, user])
        self.assertEqual(store, result["store"])
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
                   "onlineName": "85", "hierDelim": "86", "boxFlags": "87"}
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
        self.clean_profile(False)
        name = self.register_selected_profile()
        source = self.profile / "s526-original.mab"
        fixture = Path(__file__).resolve().parents[3] / (
            "mail/components/addrbook/test/browser/data/import.mab")
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

    def create_legacy_imap_source(self):
        """Create genuine root and UID-bearing child summaries with legacy APIs."""
        self.clean_profile(False)
        source = self.marionette.execute_script("""
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
            database.addNewHdrToDB(header, false);
            database.summaryValid = true;
            database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root: file.path,
              rootSummary: server.rootFolder.summaryFile.path,
              summary: folder.summaryFile.path,
              flags: (database.dBFolderInfo.flags >>> 0).toString(16),
              folderName: folder.name, onlineName: imap.onlineName,
              hierDelim: imap.hierarchyDelimiter.charCodeAt(0).toString(16),
              boxFlags: '0'};
        """)
        return source

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
        cache = self.write_legacy_cache([{"key": str(summary), **{
            name: source[name] for name in
            ["flags", "folderName", "onlineName", "hierDelim", "boxFlags"]}}])
        cache_bytes = cache.read_bytes()
        self.start_same_profile(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(1, len(selected["record"]["identity"]["imports"]))
        self.assertEqual(1, len(selected["record"]["identity"]["caches"]))
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

    def test_nativeImapRootSummaryRefusesUnknownAndMessageData(self):
        for case in ["message-data", "unknown-sibling"]:
            source = self.create_legacy_imap_source()
            self.stop_application()
            summary = Path(source["summary"])
            root_summary = Path(source["rootSummary"])
            files = [summary, root_summary]
            if case == "message-data":
                # Use genuine original message-bearing Mork, not invented rows.
                root_summary.write_bytes(summary.read_bytes())
            else:
                unknown = root_summary.with_name("unconfigured-root.msf")
                unknown.write_bytes(root_summary.read_bytes())
                files.append(unknown)
            self.assert_startup_refuses(files, absent=[
                self.profile / "panorama.sqlite",
                self.profile / "panorama-profile.json",
            ])
            work = self.profile.parent / ("panorama-migration-" + self.profile.name)
            if work.exists():
                self.created_work.add(work)

    def test_invalidActiveJsonCacheNeverFallsBackToMork(self):
        for case in ["malformed", "array", "negativeFlags", "objectName"]:
            self.clean_profile(False)
            source = self.create_legacy_message("mbox")
            self.stop_application()
            summary = Path(source["summary"])
            legacy = self.write_legacy_cache([{"key": str(summary),
                "flags": format(source["flags"] & 0xffffffff, "x"),
                "folderName": source["name"]}])
            cache = self.profile / "folderCache.json"
            raw = {
                "malformed": b'{corrupt JSON',
                "array": b'[]',
                "negativeFlags": json.dumps({str(summary): {"flags": -1}}).encode(),
                "objectName": json.dumps({str(summary): {"folderName": {}}}).encode(),
            }[case]
            cache.write_bytes(raw)
            self.assert_startup_refuses([cache, legacy, summary], absent=[
                self.profile / "panorama.sqlite",
                self.profile / "panorama-profile.json"])

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
        code = self.marionette.instance.runner.wait(
            timeout=self.marionette.startup_timeout
        )
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
    def test_interruptedStartupBackupIsNeverAccepted(self):
        """S7-15.1: cut the real opt-in startup copy; restart never accepts it."""
        self.clean_profile(False)
        source = self.create_legacy_message("mbox")
        self.stop_application()
        limit = self.largest_file_limit([self.profile])
        large = self.profile / "s715-large-backup-input"
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
        self.assertFalse((backup / profile_root["directory"] / large.name).exists(),
                         "The cut file is never installed in the archive")
        self.assert_cut_copy(backup / "scratch", large, limit)
        for absent in (work / "journal.json", self.profile / "panorama-profile.json",
                       self.profile / "panorama.sqlite"):
            self.assertFalse(absent.exists(), "No migration state follows a partial copy")
        self.assertEqual(digest, hashlib.sha256(large.read_bytes()).hexdigest())
        for path, contents in originals.items():
            self.assertEqual(contents, path.read_bytes())

        # Partial work without a selector is explicit recovery: restart never
        # accepts, resumes or replaces the incomplete archive.
        self.assert_startup_refuses(
            [backup / "manifest.json", large, *originals],
            absent=[work / "journal.json", self.profile / "panorama-profile.json",
                    self.profile / "panorama.sqlite"],
        )
        self.assertIs(False, json.loads((backup / "manifest.json").read_bytes())["complete"])
        self.assertFalse((backup / profile_root["directory"] / large.name).exists())

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
        self.assertIn("lastError", journal_state, "The interrupted cutover is recorded")
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

        retained = [selector, journal, database, *summaries]
        self.assert_startup_refuses(retained)
        before = {path: path.read_bytes() for path in retained}
        self.marionette.instance.profile.set_preferences({"mail.panorama.enabled": False})
        self.marionette.instance.start()
        code = self.marionette.instance.runner.wait(timeout=self.marionette.startup_timeout)
        self.assertEqual(5, code, "Legacy default never ignores an unvalidated selection")
        for path, contents in before.items():
            self.assertEqual(contents, path.read_bytes())
        self.assertEqual(mappings, self.native_unit_mappings())
        self.assertEqual("prepared", json.loads(selector.read_bytes())["state"])

    @unittest.skipUnless(sys.platform.startswith("linux"), "POSIX file-size limit")
    def test_interruptedRestoreCopyClaimsNoCompletion(self):
        """S7-15.4: cut the real native restore copy; never claim completion."""
        backup, markers, archive = self.external_restore_point()
        external = [marker.parent for marker in markers[1:]]
        limit = self.largest_file_limit([self.profile, backup, *external])
        newer = self.profile / "s715-newer-before-restore"
        digest = self.write_large_file(newer, 4 * limit)
        archived = self.file_digests(backup)
        request = self.approve_restore(backup)
        self.marionette.instance.app_args = self.original_args
        self.start_with_file_size_limit(limit)

        self.assert_cut_copy(request["stagingParent"], newer, limit)
        pending = self.restore_request_path()
        self.assertEqual(request["operationId"], json.loads(pending.read_text())["operationId"])
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
        if code == 5:
            # Interrupted work blocks; the documented exact-operation retry follows.
            self.assertEqual(request["operationId"],
                             json.loads(pending.read_text())["operationId"])
            self.assertFalse(pending.with_name("restore-current.json").exists())
            for marker in markers:
                self.assertEqual(b"newer retained restore bytes\n", marker.read_bytes())
            self.restore_exit(["--panorama-restore-retry"])
            self.assertTrue(list(pending.parent.glob(
                f'restore-{request["operationId"]}-*.failed.json')))
            self.restore_exit()
        else:
            self.assertEqual(0, code, "Restart either refuses or settles the restore")
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
