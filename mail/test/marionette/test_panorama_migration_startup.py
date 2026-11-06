# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import errno
import hashlib
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

from marionette_driver import Wait
from marionette_harness import MarionetteTestCase


class TestPanoramaMigrationStartup(MarionetteTestCase):
    """Exercise the production command on the ordinary stopped-child runner."""

    def setUp(self):
        super().setUp()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.paths = self.marionette.execute_script(
            "return ['ProfD', 'ProfLD'].map(k => Services.dirsvc.get(k, Ci.nsIFile).path);"
        )
        self.profile = Path(self.paths[0])
        self.original_args = list(self.marionette.instance.app_args)
        self.original_instance_prefs = self.marionette.instance.prefs
        self.original_gecko_log = self.marionette.instance._gecko_log
        self.child_log = None
        self.child_log_dumped = False
        self.saved_prefs = {}
        self.work = tempfile.TemporaryDirectory(prefix="s508-selected-startup-")
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.operation = uuid.uuid4().hex
        self.pending_file = self.profile / ("s508-pending-" + self.operation)
        self.account_keys = []
        self.large_digest = None
        self.archive_path = None
        self.owned_log_dirs = []

    def configure(self, large=True):
        """Persist real external mbox/maildir/news selections before shutdown."""
        mbox, maildir, news, metadata = [
            self.root / name for name in ("mbox", "maildir", "news", "metadata")
        ]
        for directory in (mbox, maildir, news, metadata, self.root / "control"):
            directory.mkdir()
        (maildir / "Inbox").mkdir()
        for name in ("cur", "new", "tmp"):
            (maildir / "Inbox" / name).mkdir()
        message = (
            b"From: sender@example.invalid\nTo: receiver@example.invalid\n"
            b"Date: Thu, 01 Jan 1970 00:00:00 +0000\n"
            b"Message-ID: <s508@example.invalid>\nSubject: exact source\n\nOriginal body.\n"
        )
        self.original_messages = {
            mbox / "Inbox": b"From sender@example.invalid Thu Jan 01 00:00:00 1970\n" + message,
            maildir / "Inbox" / "cur" / "original": message,
        }
        for path, raw in self.original_messages.items():
            path.write_bytes(raw)
        self.newsrc = metadata / "original-newsrc"
        self.newsrc.write_bytes(b"mozilla.test: 1-3\n")
        self.unrelated = metadata / "unrelated-sibling"
        self.unrelated.write_bytes(b"Do not copy this unselected sibling.\n")
        prefs = {
            "mail.panorama.enabled": False,
            "mailnews.database.global.indexer.enabled": False,
            "offline.startup_state": 2,
            "mailnews.sendInBackground": False,
        }
        for suffix, kind, directory, store in (
            ("box", "imap", mbox, "berkeleystore"),
            ("dir", "imap", maildir, "maildirstore"),
            ("news", "nntp", news, "berkeleystore"),
        ):
            key = "s508" + suffix + self.operation
            account = "a" + key
            self.account_keys.append(account)
            prefs.update({
                f"mail.account.{account}.server": key,
                f"mail.server.{key}.type": kind,
                f"mail.server.{key}.hostname": "example.invalid",
                f"mail.server.{key}.userName": "s508",
                f"mail.server.{key}.directory": str(directory),
                f"mail.server.{key}.storeContractID": f"@mozilla.org/msgstore/{store};1",
            })
            if kind == "nntp":
                prefs[f"mail.server.{key}.newsrc.file"] = str(self.newsrc)
                prefs[f"mail.server.{key}.mail.newsrc_root"] = str(news)
        # A persisted orphan branch and an absent external leaf must also be
        # inventoried without constructing another account or creating the leaf.
        orphan_root = self.root / "orphan-news"
        orphan_root.mkdir()
        self.absent_newsrc = metadata / "not-created-newsrc"
        orphan_key = "s508orphan" + self.operation
        prefs.update({
            f"mail.server.{orphan_key}.type": "nntp",
            f"mail.server.{orphan_key}.hostname": "orphan.example.invalid",
            f"mail.server.{orphan_key}.directory": str(orphan_root),
            f"mail.server.{orphan_key}.storeContractID": "@mozilla.org/msgstore/berkeleystore;1",
            f"mail.server.{orphan_key}.newsrc.file": str(self.absent_newsrc),
            f"mail.server.{orphan_key}.mail.newsrc_root": str(orphan_root),
        })
        # Persist a real SMTP identity/FCC/Outbox configuration. The stopped
        # child discovers these descriptors without opening their services.
        local_key = "s508local" + self.operation
        self.local_account = "a" + local_key
        self.identity_key = "s508identity" + self.operation
        smtp_key = "s508smtp" + self.operation
        local_root = self.root / "outbox-store"
        local_root.mkdir()
        local_host = "s508-local-" + self.operation
        local_uri = "mailbox://nobody@" + local_host
        self.account_keys.append(self.local_account)
        prefs.update({
            f"mail.account.{self.local_account}.server": local_key,
            f"mail.account.{self.local_account}.identities": self.identity_key,
            "mail.accountmanager.localfoldersserver": local_key,
            f"mail.server.{local_key}.type": "none",
            f"mail.server.{local_key}.hostname": local_host,
            f"mail.server.{local_key}.userName": "nobody",
            f"mail.server.{local_key}.directory": str(local_root),
            f"mail.server.{local_key}.storeContractID": "@mozilla.org/msgstore/berkeleystore;1",
        })
        smtp_servers = self.marionette.get_pref("mail.smtpservers") or ""
        self.outgoing_prefs = {
            "mail.smtpservers": ",".join(
                [key for key in smtp_servers.split(",") if key] + [smtp_key]
            ),
            f"mail.smtpserver.{smtp_key}.hostname": "smtp.example.invalid",
            f"mail.smtpserver.{smtp_key}.username": "s508",
            f"mail.smtpserver.{smtp_key}.port": 587,
            f"mail.smtpserver.{smtp_key}.try_ssl": 2,
            f"mail.identity.{self.identity_key}.fullName": "S508 retained sender",
            f"mail.identity.{self.identity_key}.useremail": "sender@example.invalid",
            f"mail.identity.{self.identity_key}.smtpServer": smtp_key,
            f"mail.identity.{self.identity_key}.doFcc": True,
            f"mail.identity.{self.identity_key}.fcc_folder": local_uri + "/Sent",
            f"mail.identity.{self.identity_key}.draft_folder": local_uri + "/Drafts",
            f"mail.identity.{self.identity_key}.stationery_folder": local_uri + "/Templates",
        }
        prefs.update(self.outgoing_prefs)
        for name in ("Sent", "Drafts", "Templates"):
            (local_root / name).write_bytes(b"")
        queued = (
            b"From sender@example.invalid Thu Jan 01 00:00:00 1970\n"
            + f"X-Mozilla-Identity-Key: {self.identity_key}\n".encode()
            + f"X-Mozilla-Account-Key: {self.local_account}\n".encode()
            + f"FCC: {local_uri}/Sent\n".encode()
            + message
        )
        self.original_messages[local_root / "Unsent Messages"] = queued
        (local_root / "Unsent Messages").write_bytes(queued)
        old_accounts = self.marionette.get_pref("mail.accountmanager.accounts") or ""
        prefs["mail.accountmanager.accounts"] = ",".join(
            [key for key in old_accounts.split(",") if key] + self.account_keys
        )
        for name, value in prefs.items():
            self.saved_prefs[name] = self.marionette.execute_script(
                """const n = arguments[0]; return {
                  user: Services.prefs.prefHasUserValue(n),
                  value: Services.prefs.getPrefType(n) == Ci.nsIPrefBranch.PREF_STRING
                    ? Services.prefs.getStringPref(n)
                    : Services.prefs.getPrefType(n) == Ci.nsIPrefBranch.PREF_BOOL
                    ? Services.prefs.getBoolPref(n)
                    : Services.prefs.getPrefType(n) == Ci.nsIPrefBranch.PREF_INT
                    ? Services.prefs.getIntPref(n) : null
                };""",
                script_args=[name],
            )
            self.marionette.set_pref(name, value)
        self.marionette.instance.prefs = {
            **(self.original_instance_prefs or {}), **prefs
        }
        self.marionette.execute_script("Services.prefs.savePrefFile(null);")
        details = self.marionette.quit(in_app=True, clean=False)
        self.assertTrue(details["in_app"])
        self.assertFalse(details["forced"])
        self.assertEqual(0, self.marionette.instance.runner.returncode)
        # A genuine stopped native-log archive requires no live OP logger.
        archive_account = "s508-" + self.operation
        archive_root = self.profile / "logs" / "search-test" / archive_account
        for directory in (archive_root.parent.parent, archive_root.parent, archive_root, archive_root / "buddy"):
            if not directory.exists():
                directory.mkdir()
                self.owned_log_dirs.append(directory)
        self.archive_path = archive_root / "buddy" / "2022-03-04.120000+0000.json"
        archive = (
            b'{"date":"2022-03-04T12:00:00.000Z","name":"buddy",'
            + f'"title":"Retained S508 archive","account":"{archive_account}",'.encode()
            + b'"normalizedName":"buddy","protocol":"search-test","isChat":false}\n'
            b'{"date":"2022-03-04T12:00:01.000Z","who":"sender",'
            b'"text":"retained-s508-archive-source","flags":["incoming"],'
            b'"remoteId":"s508-archive-first"}\n'
        )
        self.archive_path.write_bytes(archive)
        self.original_messages[self.archive_path] = archive
        # Actual regular bytes, not sparse extents or a production delay hook.
        block = bytes(range(256)) * 4096
        digest = hashlib.sha256()
        with self.pending_file.open("xb") as stream:
            for _ in range(256 if large else 1):
                stream.write(block)
                digest.update(block)
            stream.flush()
            os.fsync(stream.fileno())
        self.large_digest = digest.hexdigest()
        self.original_nss = {
            name: self.file_digest(self.profile / name)
            for name in ("cert9.db", "key4.db", "pkcs11.txt")
        }
        control = self.root / "control"
        self.request = {
            "version": 1,
            "operationId": self.operation,
            "profilePath": self.paths[0],
            "localProfilePath": self.paths[1],
            "backupPath": str(control / "backup"),
            "journalPath": str(control / "journal.json"),
            "resultPath": str(control / "result.json"),
            "cancelPath": str(control / "cancel.json"),
        }

    @staticmethod
    def file_digest(path):
        """Hash actual file bytes without loading the entire fixture in memory."""
        if not path.exists():
            return None
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    def start_selected(self):
        """Start the existing runner directly, observing before Marionette starts."""
        path = self.root / "control" / "request.json"
        with path.open("x", encoding="utf-8") as stream:
            json.dump(self.request, stream)
            stream.flush()
            os.fsync(stream.fileno())
        self.marionette.instance.app_args = [
            *self.original_args, "--panorama-profile-snapshot", str(path)
        ]
        # Use the existing GeckoInstance logfile destination. The runner,
        # source binary, profile selection and startup path stay unchanged.
        self.child_log = self.root / "selected-child-gecko.log"
        self.marionette.instance._gecko_log = str(self.child_log)
        self.marionette.instance.start()
        self.child_pid = self.marionette.instance.runner.process_handler.pid
        self.assertTrue(self.marionette.instance.runner.is_running())
        self.assertIsNone(self.marionette.session_id)

    def wait_record(self, path, predicate=lambda record: True):
        """Observe actual atomic output; a deadline never counts as settlement."""
        def read(_):
            if path.exists():
                try:
                    record = json.loads(path.read_text(encoding="utf-8"))
                except (FileNotFoundError, json.JSONDecodeError):
                    record = None
                if record is not None and predicate(record):
                    return record
            self.assertIsNone(
                self.marionette.instance.runner.returncode,
                "Selected child exited before the required observable receipt",
            )
            return False

        return Wait(self.marionette, timeout=self.marionette.startup_timeout, interval=0.01).until(read)

    def assert_profile_locked(self):
        """A second real OS lock acquisition must fail while the child owns XRE."""
        if sys.platform == "win32":
            try:
                stream = (self.profile / "parent.lock").open("r+b")
            except PermissionError:
                return
            stream.close()
            self.fail("The live selected Windows profile lock was opened")
        else:
            import fcntl

            with (self.profile / ".parentlock").open("r+b") as stream:
                try:
                    fcntl.lockf(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as error:
                    self.assertIn(error.errno, (errno.EACCES, errno.EAGAIN))
                else:
                    fcntl.lockf(stream, fcntl.LOCK_UN)
                    self.fail("The live selected profile lock was acquired twice")

    def pending_copy(self):
        """Require the genuine large-file copy while the real child is alive."""
        progress = Path(self.request["resultPath"] + ".progress")
        record = self.wait_record(
            progress,
            lambda r: r["state"] == "COPY_PENDING"
            and r["copy"]["source"] == str(self.pending_file)
            and r["copy"]["settled"] is None,
        )
        self.assertEqual(self.child_pid, record["pid"])
        self.assertEqual(self.operation, record["operationId"])
        self.assertGreater(record["generation"], 0)
        self.assertFalse(self.absent_newsrc.exists())
        self.assert_profile_locked()
        return record

    def assert_sources(self):
        """Keep exact original bodies and unrelated external metadata intact."""
        self.assertEqual(self.large_digest, self.file_digest(self.pending_file))
        for path, raw in self.original_messages.items():
            self.assertEqual(raw, path.read_bytes())
        if not self.marionette.session_id:
            self.assertFalse(self.absent_newsrc.exists())
        self.assertEqual(b"mozilla.test: 1-3\n", self.newsrc.read_bytes())
        self.assertEqual(
            b"Do not copy this unselected sibling.\n", self.unrelated.read_bytes()
        )

    def assert_native_settlement(self, expected_error=None, generation=None):
        """Require the actual native once-release terminal, never infer it from exit.

        The literal diagnostic is bound to the original Core source request;
        its checked implementation remains required before whole validation.
        """
        self.assertIsNotNone(self.child_log)
        self.assertTrue(self.child_log.exists())
        prefix = "PANORAMA_SNAPSHOT_SETTLED "
        records = [
            json.loads(line.split(prefix, 1)[1])
            for line in self.child_log.read_text(encoding="utf-8").splitlines()
            if prefix in line
        ]
        self.assertEqual(1, len(records), "Exactly one actual native settlement")
        record = records[0]
        self.assertEqual(self.child_pid, record["pid"])
        self.assertGreater(record["generation"], 0)
        if generation is not None:
            self.assertEqual(generation, record["generation"])
        self.assertIs(record["consumer_settled"], True)
        self.assertIs(record["release_started"], True)
        self.assertEqual(1, record["release_passes"])
        self.assertEqual(1, record["release_completions"])
        self.assertIsInstance(record["first_error"], int)
        if expected_error is not None:
            self.assertEqual(expected_error, record["first_error"])
        else:
            self.assertNotEqual(0, record["first_error"])
        self.assertEqual(
            "released" if record["first_error"] == 0 else "failed", record["phase"]
        )
        return record

    def assert_failed_exit(self):
        """Require actual normal process exit, not a session timeout or forced stop."""
        runner = self.marionette.instance.runner
        Wait(self.marionette, timeout=self.marionette.startup_timeout).until(
            lambda _: runner.returncode is not None
        )
        self.assertNotEqual(0, runner.returncode)
        self.assertIsNone(self.marionette.session_id)
        self.assert_sources()
        self.assertEqual(
            self.original_nss,
            {name: self.file_digest(self.profile / name) for name in self.original_nss},
        )

    def test_selected_xre_lock_held_until_snapshot_settles(self):
        self.configure()
        self.start_selected()
        self.pending_copy()
        result = self.wait_record(Path(self.request["resultPath"]))
        self.assertEqual("CONSUMER_VERIFIED", result["state"])
        self.assertEqual("PENDING", result["nativeRelease"])
        self.assertEqual(self.child_pid, result["pid"])
        # Receipt alone is not release proof. Actual same-child app startup and
        # native new-writer admission below require the real outer release path.
        self.marionette.raise_for_port(timeout=self.marionette.startup_timeout)
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        observed = self.marionette.execute_script("""
          const gate = Cc['@mozilla.org/mailnews/migration-writer-lease;1']
            .getService(Ci.nsIObserver);
          const subject = gate.QueryInterface(Ci.nsIPropertyBag2)
            .getPropertyAsInterface('writer-admission-subject', Ci.nsISupports);
          gate.observe(subject, 'check-writer-admission', 'compose');
          return { pid: Services.appinfo.processID,
            profile: Services.dirsvc.get('ProfD', Ci.nsIFile).path,
            enabled: Services.prefs.getBoolPref('mail.panorama.enabled') };
        """)
        self.assertEqual(self.child_pid, observed["pid"])
        self.assertEqual(self.paths[0], observed["profile"])
        self.assertFalse(observed["enabled"])
        self.assert_native_settlement(0, result["generation"])
        self.assert_sources()
        bundle = Path(self.request["backupPath"])
        snapshot = json.loads((bundle / "snapshot.json").read_text(encoding="utf-8"))
        self.assertEqual("selected-profile-snapshot", snapshot["kind"])
        self.assertTrue(snapshot["complete"])
        outgoing = {row["name"]: row["value"] for row in snapshot["inventory"]["outgoing"]}
        for name, expected in self.outgoing_prefs.items():
            self.assertEqual(expected, outgoing[name])
            self.assertEqual(expected, self.marionette.get_pref(name))
        account = next(
            row for row in snapshot["inventory"]["accounts"]
            if row["key"] == self.local_account
        )
        self.assertEqual(self.identity_key, account["identities"])
        self.assertEqual(result["backup"]["sha256"], self.file_digest(bundle / "snapshot.json"))
        self.assertEqual(
            sorted([
                {"source": str(self.newsrc), "exists": True},
                {"source": str(self.absent_newsrc), "exists": False},
            ], key=lambda row: row["source"]),
            sorted([
                {"source": row["source"], "exists": row["exists"]}
                for row in snapshot["externalFiles"]
            ], key=lambda row: row["source"]),
        )
        files = list((bundle / "files").iterdir())
        self.assertEqual(1, len(files))
        self.assertEqual(self.newsrc.read_bytes(), files[0].read_bytes())
        directories = json.loads((bundle / "directories" / "manifest.json").read_text(encoding="utf-8"))
        for original, raw in self.original_messages.items():
            matches = [
                bundle / "directories" / root["directory"] / Path(*entry["parts"])
                for root in directories["roots"]
                for entry in root["entries"]
                if Path(root["source"], *entry["parts"]) == original
            ]
            self.assertEqual(1, len(matches))
            self.assertEqual(raw, matches[0].read_bytes())
        profile_root = directories["roots"][0]
        for name, digest in self.original_nss.items():
            matches = [entry for entry in profile_root["entries"] if entry["parts"] == [name]]
            self.assertEqual([] if digest is None else [digest], [entry["sha256"] for entry in matches])

    def test_snapshot_rejection_blocks_startup_and_preserves_sources(self):
        self.configure(large=False)
        wrong_parent = self.root / "not-a-directory"
        wrong_parent.write_bytes(b"Original parent must remain a file.\n")
        self.request["journalPath"] = str(wrong_parent / "journal.json")
        self.start_selected()
        self.assert_failed_exit()
        self.assert_native_settlement()
        self.assertEqual(b"Original parent must remain a file.\n", wrong_parent.read_bytes())
        self.assertFalse(Path(self.request["backupPath"]).exists())

    def test_cancelled_snapshot_waits_for_settlement_and_releases_once(self):
        self.configure()
        self.start_selected()
        pending = self.pending_copy()
        with Path(self.request["cancelPath"]).open("x", encoding="utf-8") as stream:
            json.dump({"operationId": self.operation}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        result = self.wait_record(Path(self.request["resultPath"]))
        self.assertEqual("CONSUMER_FAILED", result["state"])
        self.assertEqual(0x80004004, result["error"]["result"])
        self.assertEqual(pending["copy"]["source"], result["copy"]["source"])
        # A cancel that races completed IO earns no pending-settlement credit.
        self.assertLess(result["copy"]["started"], result["cancellation"]["modified"])
        self.assertLess(result["cancellation"]["modified"], result["copy"]["settled"])
        self.assertLessEqual(result["copy"]["settled"], result["cancellation"]["observed"])
        self.assertIsNone(result["backup"])
        self.assert_failed_exit()
        self.assert_native_settlement(0x80004004, result["generation"])
        self.assertFalse((Path(self.request["backupPath"]) / "snapshot.json").exists())

    def tearDown(self):
        try:
            self.marionette.instance._gecko_log = self.original_gecko_log
            self.marionette.instance.app_args = self.original_args
            self.marionette.instance.prefs = self.original_instance_prefs
            if not self.marionette.session_id:
                if self.marionette.instance.runner.is_running():
                    # Only our own recorded child; forced cleanup is a test
                    # failure recovery, never evidence of safe lease release.
                    self.logger.error("Selected child did not settle; stopping owned test process")
                    self.marionette.instance.close()
                self.marionette.start_session()
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.marionette.execute_script("""
              const { MailServices } = ChromeUtils.importESModule(
                'resource:///modules/MailServices.sys.mjs');
              for (const key of arguments[0]) {
                const account = MailServices.accounts.getAccount(key);
                if (account) MailServices.accounts.removeAccount(account, false);
              }
            """, script_args=[self.account_keys])
            for name, previous in self.saved_prefs.items():
                if previous["user"]:
                    self.marionette.set_pref(name, previous["value"])
                else:
                    self.marionette.clear_pref(name)
            self.marionette.execute_script("Services.prefs.savePrefFile(null);")
            details = self.marionette.quit(in_app=True, clean=False)
            self.assertFalse(details["forced"])
            self.assertEqual(0, self.marionette.instance.runner.returncode)
            self.pending_file.unlink(missing_ok=True)
            if self.archive_path is not None:
                self.archive_path.unlink(missing_ok=True)
            for directory in reversed(self.owned_log_dirs):
                directory.rmdir()
            self.log_child_output()
            self.work.cleanup()
            self.marionette.start_session()
        finally:
            try:
                self.log_child_output()
            finally:
                super().tearDown()

    def log_child_output(self):
        """Retain the complete real selected-child log in collected test output."""
        if self.child_log_dumped or self.child_log is None or not self.child_log.exists():
            return
        raw = self.child_log.read_bytes()
        self.logger.info("S508 child log SHA256 " + hashlib.sha256(raw).hexdigest())
        for line in raw.decode("utf-8", errors="replace").splitlines():
            self.logger.info("S508 raw child: " + line)
        self.child_log_dumped = True
