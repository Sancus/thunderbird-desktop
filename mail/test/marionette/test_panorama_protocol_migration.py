# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

"""Opt-in startup migration of POP3, RSS and NNTP Mork data (S5-26.1).

Each case writes genuine legacy data through the ordinary mail APIs with
Panorama disabled, quits normally, restarts the same profile with
mail.panorama.enabled, and then checks the migrated data through the ordinary
folder/header APIs and again after a repeated restart. Protocol state that is
not Mork (popstate.dat, feeds.json, feeditems.json, newsrc) must stay
byte-identical in place and be included in the verified backup.
"""

import json
import shutil
from pathlib import Path

from marionette_harness import MarionetteTestCase

LOCAL_MESSAGES = [
    {
        "messageId": "s526-protocol-read@invalid",
        "subject": "Protocol migration read",
        "author": "reader@example.invalid",
        "read": True,
        "flagged": False,
        "keywords": "$label1",
    },
    {
        "messageId": "s526-protocol-flagged@invalid",
        "subject": "Protocol migration flagged",
        "author": "flagger@example.invalid",
        "read": False,
        "flagged": True,
        "keywords": "",
    },
]

NEWS_ARTICLES = [
    {"key": 3, "messageId": "s526-news-3@invalid", "subject": "News three", "offline": False},
    {"key": 5, "messageId": "s526-news-5@invalid", "subject": "News five", "offline": False},
    {"key": 7, "messageId": "s526-news-7@invalid", "subject": "News seven", "offline": True},
]
NEWS_GROUP = "s526.test.group"
NEWS_READ = "1-5"
NEWS_KNOWN = "1-7"
NEWS_BODY = "Offline body of article seven."


class TestPanoramaProtocolMigration(MarionetteTestCase):
    """Real XRE/ordinary profile lifecycle, as in test_panorama_startup_backup."""

    def setUp(self):
        super().setUp()
        self.original_prefs = self.marionette.instance.prefs
        self.original_args = list(self.marionette.instance.app_args or [])
        self.created_work = set()
        self.profile = None

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
        self.assertEqual("active", record["state"])
        self.assertEqual("panorama", record["backend"])
        self.assertEqual(result["sourceId"], record["identity"]["databaseSourceId"])
        if record["identity"]["backup"]:
            self.created_work.add(Path(record["identity"]["backup"]["path"]).parent.parent)
        return result

    # ----- fixtures written through the ordinary legacy APIs (Panorama off) -----

    def create_pop3_source(self, store):
        source = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            Services.io.offline = true;
            Services.prefs.setBoolPref('network.manage-offline-status', false);
            Services.prefs.setIntPref('offline.startup_state', 2);
            const server = MailServices.accounts.createIncomingServer(
              's526pop', 'pop.invalid', 'pop3');
            server.setStringValue('storeContractID', arguments[0] === 'maildir'
              ? '@mozilla.org/msgstore/maildirstore;1'
              : '@mozilla.org/msgstore/berkeleystore;1');
            server.loginAtStartUp = false;
            server.doBiff = false;
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            server.QueryInterface(Ci.nsILocalMailIncomingServer).createDefaultMailboxes();
            const folder = server.rootFolder.getChildNamed('Inbox')
              .QueryInterface(Ci.nsIMsgLocalMailFolder);
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root: server.localPath.path,
              folderName: folder.name, summary: folder.summaryFile.path,
              store: folder.msgStore.storeType};
        """, script_args=[store])
        self.assertEqual(store, source["store"])
        # popstate.dat is written by a live POP3 session; without a server the
        # test writes the documented format so its bytes can be preserved.
        popstate = Path(source["root"]) / "popstate.dat"
        popstate.write_text(
            "# POP3 State File\n# This is a generated file!  Do not edit.\n\n"
            "*pop.invalid s526pop\nk s526-uidl-1 1762300800\n", encoding="utf-8")
        source["state_files"] = [str(popstate)]
        return source

    def create_rss_source(self, store):
        source = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const { FeedUtils } = ChromeUtils.importESModule(
              'resource:///modules/FeedUtils.sys.mjs');
            const { Feed } = ChromeUtils.importESModule(
              'resource:///modules/Feed.sys.mjs');
            Services.io.offline = true;
            Services.prefs.setBoolPref('network.manage-offline-status', false);
            Services.prefs.setIntPref('offline.startup_state', 2);
            const pref = 'mail.serverDefaultStoreContractID';
            const previous = Services.prefs.getCharPref(pref);
            Services.prefs.setCharPref(pref, arguments[0] === 'maildir'
              ? '@mozilla.org/msgstore/maildirstore;1'
              : '@mozilla.org/msgstore/berkeleystore;1');
            let server;
            try {
              // createRssAccount returns the account, not its server.
              server = FeedUtils.createRssAccount('S526 Feeds').incomingServer;
            } finally {
              Services.prefs.setCharPref(pref, previous);
            }
            server.doBiff = false;
            const root = server.rootFolder;
            root.createSubfolder('S526 Feed', null);
            const folder = root.getChildNamed('S526 Feed')
              .QueryInterface(Ci.nsIMsgLocalMailFolder);
            const feed = new Feed('https://feed.invalid/s526.xml', folder);
            feed.title = 'S526 Feed';
            FeedUtils.addFeed(feed);
            const items = FeedUtils.getItemsDS(server);
            items.data['https://feed.invalid/s526/item-1'] = {
              stored: true, valid: true, lastSeenTime: 1762300800000};
            items.saveSoon();
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root: server.localPath.path,
              folderName: folder.name, summary: folder.summaryFile.path,
              store: folder.msgStore.storeType, feedUrl: feed.url};
        """, script_args=[store])
        self.assertEqual(store, source["store"])
        source["state_files"] = [str(Path(source["root"]) / "feeds.json"),
                                 str(Path(source["root"]) / "feeditems.json")]
        return source

    def add_local_messages(self, source):
        """Store real messages and Mork metadata in the protocol's local folder."""
        return self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const folder = MailServices.accounts.getIncomingServer(arguments[0])
              .rootFolder.getChildNamed(arguments[1])
              .QueryInterface(Ci.nsIMsgLocalMailFolder);
            for (const item of arguments[2]) {
              const header = folder.addMessage(
                'From - Thu Nov 05 00:00:00 2026\r\n' +
                'Message-ID: <' + item.messageId + '>\r\n' +
                'From: ' + item.author + '\r\n' +
                'To: destination@example.invalid\r\n' +
                'Subject: ' + item.subject + '\r\n' +
                'Content-Base: https://feed.invalid/s526/item-1\r\n' +
                'Date: Thu, 5 Nov 2026 00:00:00 +0000\r\n\r\n' +
                'Body of ' + item.messageId + '.\r\n');
              header.markRead(item.read);
              header.markFlagged(item.flagged);
              if (item.keywords) {
                header.setStringProperty('keywords', item.keywords);
              }
              header.setStringProperty('s526-custom', 'protocol-retained');
            }
            folder.msgDatabase.dBFolderInfo.setCharProperty('s526-folder', 'kept');
            folder.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            return {flags: folder.flags,
              count: folder.msgDatabase.dBFolderInfo.numMessages};
        """, script_args=[source["serverKey"], source["folderName"], LOCAL_MESSAGES])

    def create_news_source(self):
        source = self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            Services.io.offline = true;
            Services.prefs.setBoolPref('network.manage-offline-status', false);
            Services.prefs.setIntPref('offline.startup_state', 2);
            const server = MailServices.accounts.createIncomingServer(
              null, 'news.invalid', 'nntp');
            server.loginAtStartUp = false;
            const account = MailServices.accounts.createAccount();
            account.incomingServer = server;
            const nntp = server.QueryInterface(Ci.nsINntpIncomingServer);
            nntp.subscribeToNewsgroup(arguments[0]);
            const folder = server.rootFolder.getChildNamed(arguments[0]);
            const news = folder.QueryInterface(Ci.nsIMsgNewsFolder);
            news.setReadSetFromStr(arguments[1]);
            const database = folder.msgDatabase;
            database.dBFolderInfo.knownArtsSet = arguments[2];
            const encoder = new TextEncoder();
            for (const item of arguments[3]) {
              const header = database.createNewHdrWithSpecificMsgKey(item.key);
              header.messageId = item.messageId;
              header.subject = item.subject;
              header.author = 'poster@example.invalid';
              header.date = 1762300800000000;
              header.setStringProperty('s526-custom', 'news-retained');
              database.addNewHdrToDB(header, false);
              if (item.offline) {
                const store = folder.msgStore;
                const stream = store.getNewMsgOutputStream(folder);
                const raw = 'Message-ID: <' + item.messageId + '>\r\n' +
                  'Subject: ' + item.subject + '\r\n' +
                  'From: poster@example.invalid\r\n\r\n' + arguments[4] + '\r\n';
                const bytes = encoder.encode(raw);
                const binary = Cc['@mozilla.org/binaryoutputstream;1']
                  .createInstance(Ci.nsIBinaryOutputStream);
                binary.setOutputStream(stream);
                binary.writeByteArray(Array.from(bytes));
                header.storeToken = store.finishNewMessage(folder, stream);
                header.offlineMessageSize = bytes.length;
                header.orFlags(Ci.nsMsgMessageFlags.Offline);
              }
            }
            database.summaryValid = true;
            database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
            nntp.writeNewsrcFile();
            Services.prefs.savePrefFile(null);
            return {serverKey: server.key, root: server.localPath.path,
              folderName: folder.name, summary: folder.summaryFile.path,
              newsrc: nntp.newsrcFilePath.path, flags: folder.flags};
        """, script_args=[NEWS_GROUP, NEWS_READ, NEWS_KNOWN, NEWS_ARTICLES, NEWS_BODY])
        source["state_files"] = [source["newsrc"]]
        return source

    # ----- ordinary reads after activation -----

    def local_messages(self, source):
        return self.marionette.execute_script(r"""
            const { MailServices } = ChromeUtils.importESModule(
              'resource:///modules/MailServices.sys.mjs');
            const folder = MailServices.accounts.getIncomingServer(arguments[0])
              .rootFolder.getChildNamed(arguments[1]);
            const headers = [...folder.msgDatabase.enumerateMessages()];
            return {
              flags: folder.flags,
              store: folder.msgStore.storeType,
              folderProperty: folder.msgDatabase.dBFolderInfo.getCharProperty('s526-folder'),
              messages: headers.map(header => ({
                messageId: header.messageId, subject: header.subject,
                author: header.author, read: header.isRead,
                flagged: header.isFlagged,
                keywords: header.getStringProperty('keywords'),
                custom: header.getStringProperty('s526-custom'),
                key: header.messageKey})).sort((a, b) => a.messageId < b.messageId ? -1 : 1),
            };
        """, script_args=[source["serverKey"], source["folderName"]])

    def news_messages(self, source):
        result = self.marionette.execute_async_script(r"""
            const done = arguments[arguments.length - 1];
            (async () => {
              const { MailServices } = ChromeUtils.importESModule(
                'resource:///modules/MailServices.sys.mjs');
              const { NetUtil } = ChromeUtils.importESModule(
                'resource://gre/modules/NetUtil.sys.mjs');
              const folder = MailServices.accounts.getIncomingServer(arguments[0])
                .rootFolder.getChildNamed(arguments[1]);
              const headers = [...folder.msgDatabase.enumerateMessages()];
              const messages = [];
              for (const header of headers) {
                let body = null;
                if (folder.hasMsgOffline(header.messageKey)) {
                  const stream = folder.getMsgInputStream(header);
                  body = NetUtil.readInputStreamToString(
                    stream, stream.available(), {charset: 'UTF-8'});
                  stream.close();
                }
                // Native physical keys are independent of article numbers.
                messages.push({key: header.messageKey,
                  article: header.getUint32Property('newsArticleNumber'),
                  messageId: header.messageId,
                  subject: header.subject, read: header.isRead,
                  offline: !!(header.flags & Ci.nsMsgMessageFlags.Offline),
                  custom: header.getStringProperty('s526-custom'), body});
              }
              messages.sort((a, b) => a.article - b.article);
              return {flags: folder.flags, messages,
                knownArts: folder.msgDatabase.dBFolderInfo.knownArtsSet};
            })().then(done, error => done({error: String(error)}));
        """, script_args=[source["serverKey"], source["folderName"]])
        self.assertNotIn("error", result)
        return result

    # ----- shared flow -----

    def snapshot(self, source):
        root = Path(source["root"]).resolve()
        files = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
        state = {Path(p).resolve(): Path(p).read_bytes() for p in source["state_files"]}
        return files, state

    def migrate_and_reuse(self, source, check):
        """First opted-in start migrates; every later start reuses the same data."""
        self.stop_application()
        files, state = self.snapshot(source)
        self.assertIn(Path(source["summary"]).resolve(), files)
        for path, data in state.items():
            self.assertTrue(data, "non-Mork state must exist before migration: %s" % path)
        self.assertFalse((self.profile / "panorama.sqlite").exists())

        self.start_same_profile(True)
        selected = self.selection()
        record = selected["record"]
        self.assertEqual("migrated", record["origin"])
        self.assertTrue(record["identity"]["imports"])
        first = check()
        backup = Path(record["identity"]["backup"]["path"])
        manifest = json.loads(backup.read_text())
        self.assertTrue(manifest["complete"])
        for path, data in {**files, **state}.items():
            self.assertEqual(data, path.read_bytes(), "source changed: %s" % path)
            archived = backup.parent / "root-0" / path.relative_to(self.profile)
            self.assertEqual(data, archived.read_bytes(), "not backed up: %s" % path)

        # Stale legacy Mork must never be imported again on reuse.
        self.stop_application()
        selector = (self.profile / "panorama-profile.json").read_bytes()
        journal_path = Path(record["identity"]["journalPath"])
        journal = journal_path.read_bytes()
        Path(source["summary"]).write_bytes(b"stale legacy Mork must not be imported\n")
        for _ in range(2):
            self.start_same_profile(True)
            repeated = self.selection()
            self.assertEqual(selected["sourceId"], repeated["sourceId"])
            self.assertEqual(first, check())
            self.assertEqual(selector, (self.profile / "panorama-profile.json").read_bytes())
            self.assertEqual(journal, journal_path.read_bytes())
            for path, data in state.items():
                self.assertEqual(data, path.read_bytes(), "state changed on reuse: %s" % path)
            self.stop_application()
        return first

    def assert_local_protocol(self, create, store):
        self.clean_profile(False)
        source = create(store)
        before = self.add_local_messages(source)
        self.assertEqual(len(LOCAL_MESSAGES), before["count"])

        def check():
            result = self.local_messages(source)
            self.assertEqual(store, result["store"])
            self.assertEqual(before["flags"], result["flags"])
            self.assertEqual("kept", result["folderProperty"])
            fields = ("messageId", "subject", "author", "read", "flagged", "keywords")
            got = [{k: m[k] for k in fields}
                   for m in result["messages"]]
            self.assertEqual(sorted(LOCAL_MESSAGES, key=lambda m: m["messageId"]), got)
            self.assertTrue(all(m["custom"] == "protocol-retained" for m in result["messages"]))
            return result

        self.migrate_and_reuse(source, check)

    # ----- cases -----

    def test_pop3_mbox_migration_and_reuse(self):
        self.assert_local_protocol(self.create_pop3_source, "mbox")

    def test_pop3_maildir_migration_and_reuse(self):
        self.assert_local_protocol(self.create_pop3_source, "maildir")

    def test_rss_mbox_migration_and_reuse(self):
        self.assert_local_protocol(self.create_rss_source, "mbox")

    def test_rss_maildir_migration_and_reuse(self):
        self.assert_local_protocol(self.create_rss_source, "maildir")

    def test_nntp_summary_offline_body_and_newsrc_reuse(self):
        self.clean_profile(False)
        source = self.create_news_source()
        self.assertTrue(Path(source["summary"]).is_relative_to(Path(source["root"])))
        newsrc = Path(source["newsrc"])
        self.assertIn(NEWS_GROUP + ": " + NEWS_READ, newsrc.read_text(encoding="utf-8"))

        def check():
            result = self.news_messages(source)
            self.assertEqual(source["flags"], result["flags"])
            self.assertEqual(NEWS_KNOWN, result["knownArts"])
            self.assertEqual([a["key"] for a in NEWS_ARTICLES],
                             [m["article"] for m in result["messages"]])
            for article, message in zip(NEWS_ARTICLES, result["messages"]):
                self.assertEqual(article["messageId"], message["messageId"])
                self.assertEqual(article["subject"], message["subject"])
                self.assertEqual("news-retained", message["custom"])
                # Read state comes from the unchanged newsrc range 1-5.
                self.assertEqual(article["key"] <= 5, message["read"])
                self.assertEqual(article["offline"], message["offline"])
                if article["offline"]:
                    self.assertIn(NEWS_BODY, message["body"])
                else:
                    self.assertIsNone(message["body"])
            return result

        self.migrate_and_reuse(source, check)
