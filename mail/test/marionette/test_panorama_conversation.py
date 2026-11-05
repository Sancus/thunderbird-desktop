# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import json

from marionette_driver import Wait
from marionette_harness import MarionetteTestCase


class TestPanoramaConversation(MarionetteTestCase):
    def setUp(self):
        super().setUp()
        self.fixture = None
        self.origin = None
        self.activity = None
        self.saved_prefs = {}
        self.instance_prefs = self.marionette.instance.prefs
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        profile_before = self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )
        prefs = {
            "mail.panorama.enabled": True,
            "mailnews.database.global.indexer.enabled": True,
            "mailnews.default_view_flags": 0,
            "mailnews.mark_message_read.auto": False,
            "mail.closeToTray": False,
        }
        try:
            for name, value in prefs.items():
                self.saved_prefs[name] = {
                    "user": self.marionette.execute_script(
                        "return Services.prefs.prefHasUserValue(arguments[0]);",
                        script_args=[name],
                    ),
                    "value": self.marionette.get_pref(name),
                }
                self.marionette.set_pref(name, value)
            self.marionette.instance.prefs = {**(self.instance_prefs or {}), **prefs}
            # Restart the application with the SAME profile for startup selection.
            self.marionette.restart(in_app=True, clean=False)
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.assertEqual(
                profile_before,
                self.marionette.execute_script(
                    "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
                ),
            )
            self.fixture = self.marionette.execute_script(
                r"""
                const { MailServices } = ChromeUtils.importESModule(
                    "resource:///modules/MailServices.sys.mjs"
                );
                const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"]
                    .getService(Ci.nsIDatabaseCore);
                if (!core) {
                    throw new Error("The installed Panorama backend is required");
                }
                let server = [...MailServices.accounts.allServers]
                    .find(item => item.type == "none");
                let accountKey = null;
                if (!server) {
                    MailServices.accounts.createLocalMailAccount();
                    server = MailServices.accounts.localFoldersServer;
                    accountKey = [...MailServices.accounts.accounts]
                        .find(item => item.incomingServer.key == server.key).key;
                }
                const root = server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
                const name = arguments[0];
                const folders = ["First", "Second", "Outside"].map(suffix =>
                    root.createLocalSubfolder(name + suffix)
                        .QueryInterface(Ci.nsIMsgLocalMailFolder)
                );
                const parentId = `${name}-parent@conversation.invalid`;
                const raw = (id, references = null) => [
                    "From: Conversation Sender <sender@example.invalid>",
                    "To: Conversation Recipient <recipient@example.invalid>",
                    "Date: Wed, 01 Jan 2025 00:00:00 +0000",
                    `Subject: ${name}`,
                    `Message-ID: <${id}>`,
                    ...(references ? [`References: <${references}>`] : []),
                    "", "Ordinary stored message.", "",
                ].join("\r\n");
                const first = folders[0].addMessage(raw(parentId));
                const reply = folders[0].addMessage(raw(`${name}-reply@conversation.invalid`, parentId));
                const selected = folders[1].addMessage(raw(parentId));
                folders[2].addMessage(raw(`${name}-outside@conversation.invalid`));
                const physical = header => ({
                    folderURI: header.folder.URI,
                    key: header.messageKey,
                    messageId: header.messageId,
                });
                return {
                    native: Services.prefs.getBoolPref("mail.panorama.enabled"),
                    accountKey,
                    folders: folders.map(folder => folder.URI),
                    expected: [first, reply, selected].map(physical),
                };
                """,
                script_args=[self._testMethodName],
            )
            self.assertTrue(self.fixture["native"])
            self.assertEqual(
                self.fixture["expected"][0]["messageId"],
                self.fixture["expected"][2]["messageId"],
            )
            self.assertNotEqual(
                self.fixture["expected"][0]["folderURI"],
                self.fixture["expected"][2]["folderURI"],
            )
            indexed = self.marionette.execute_async_script(
                """
                const done = arguments[arguments.length - 1];
                (async () => {
                    const { getMailSearchService } = ChromeUtils.importESModule(
                        "resource:///modules/panorama/MailSearch.sys.mjs"
                    );
                    const service = await getMailSearchService();
                    let progress;
                    do {
                        progress = await service.update({ limit: 500 });
                    } while (progress.moreWork);
                })().then(() => done(null), error => done(String(error)));
                """
            )
            self.assertIsNone(indexed, indexed)
            self.origin = self.open_window(
                r"""
                const { MailServices } = ChromeUtils.importESModule(
                    "resource:///modules/MailServices.sys.mjs"
                );
                const { MailUtils } = ChromeUtils.importESModule(
                    "resource:///modules/MailUtils.sys.mjs"
                );
                const selection = arguments[0];
                const folder = MailServices.folderLookup.getFolderForURL(selection.folderURI);
                MailUtils.openMessageInNewWindow(folder.msgDatabase.getMsgHdrForKey(selection.key));
                """,
                "mail:messageWindow",
                [self.fixture["expected"][2]],
            )
            Wait(self.marionette).until(
                lambda driver: driver.execute_script(
                    """
                    const selected = arguments[0];
                    const view = window.messageBrowser?.contentWindow.gDBView;
                    const header = view?.hdrForFirstSelectedMessage;
                    return view?.selection.count == 1 &&
                        header.folder.URI == selected.folderURI &&
                        header.messageKey == selected.key &&
                        header.messageId == selected.messageId;
                    """,
                    script_args=[self.fixture["expected"][2]],
                )
            )
            self.activity = self.open_window(
                r"""
                Services.ww.openWindow(null, "chrome://messenger/content/activity.xhtml",
                    "_blank", "chrome,dialog=no,all", null);
                """,
                "Activity:Manager",
            )
            # The Python driver and real tool window outlive every main window.
            for handle in self.marionette.chrome_window_handles:
                self.marionette.switch_to_window(handle)
                if self.marionette.get_window_type() == "mail:3pane":
                    self.marionette.close_chrome_window()
            self.marionette.switch_to_window(self.activity)
            self.assertEqual(0, self.main_window_count())
        except Exception:
            try:
                self.restore()
            except Exception:
                self.logger.error(
                    "Failed to restore the conversation fixture after setup failed",
                    exc_info=True,
                )
            raise

    def tearDown(self):
        try:
            self.restore()
        finally:
            super().tearDown()

    def open_window(self, script, window_type, args=()):
        """Observe a real chrome window before switching the existing driver."""
        before = set(self.marionette.chrome_window_handles)
        self.marionette.execute_script(script, script_args=args)
        handle = Wait(self.marionette).until(
            lambda driver: next(iter(set(driver.chrome_window_handles) - before), None)
        )
        self.marionette.switch_to_window(handle)
        Wait(self.marionette).until(
            lambda driver: driver.get_window_type() == window_type
            and driver.execute_script("return document.readyState == 'complete';")
        )
        return handle

    def main_window_count(self):
        return self.marionette.execute_script(
            "return [...Services.wm.getEnumerator('mail:3pane')].length;"
        )

    def open_conversation(self, cancel):
        """Drive the real command, or observe the public cancellation completion."""
        self.marionette.execute_script(
            r"""
            const [selection, cancel] = arguments;
            const { ConversationOpener } = ChromeUtils.importESModule(
                "resource:///modules/ConversationOpener.sys.mjs"
            );
            const origin = Services.wm.getMostRecentWindow("mail:messageWindow");
            if (!origin || Services.wm.getMostRecentWindow("mail:3pane")) {
                throw new Error("Real standalone origin and zero main windows required");
            }
            const content = origin.messageBrowser.contentWindow;
            const header = content.gDBView.hdrForFirstSelectedMessage;
            if (content.gDBView.selection.count != 1 ||
                header.folder.URI != selection.folderURI ||
                header.messageKey != selection.key ||
                header.messageId != selection.messageId) {
                throw new Error("Standalone controller has a different physical selection");
            }
            const state = window.conversation097 = {
                origin, cancel, created: null, started: null,
                baseline: [], openedTabs: 0, completionCount: 0,
                windowEvents: [],
            };
            Services.prefs.setBoolPref("mailnews.database.global.indexer.enabled", false);
            state.disabled = !content.commandController.isCommandEnabled(
                "cmd_openConversation"
            );
            Services.prefs.setBoolPref("mailnews.database.global.indexer.enabled", true);
            state.enabled = content.commandController.isCommandEnabled(
                "cmd_openConversation"
            );
            if (!state.disabled || !state.enabled) {
                throw new Error("Actual standalone command eligibility did not transition");
            }
            state.onUnload = event => state.windowEvents.push({
                event: "unload", closed: state.created.closed,
                uri: event.target.documentURI,
            });
            state.onTab = () => state.openedTabs++;
            state.startup = subject => {
                if (subject == state.created) {
                    state.started = subject;
                    state.tabmail = subject.document.getElementById("tabmail");
                    state.baseline = [...state.tabmail.tabInfo];
                    state.tabmail.tabContainer.addEventListener("TabOpen", state.onTab);
                }
            };
            state.observer = {
                observe(subject, topic) {
                    if (topic == "domwindowopened") {
                        state.created = subject;
                        subject.addEventListener("unload", state.onUnload);
                        if (cancel) {
                            origin.close();
                        }
                    }
                },
            };
            Services.ww.registerNotification(state.observer);
            Services.obs.addObserver(state.startup, "mail-startup-done");
            if (cancel) {
                const completion = new ConversationOpener(content)
                    .openConversationForMessages([header]);
                state.isPromise = typeof completion.then == "function";
                completion.then(tab => {
                    state.cancelled = tab === null;
                    state.completionCount++;
                    state.lateSuccess = tab !== null;
                }, error => {
                    state.error = { name: error.name, message: error.message,
                        result: error.result };
                    state.completionCount++;
                });
            } else {
                origin.focus();
                state.controllerFound = !!origin.getEnabledControllerForCommand(
                    "cmd_openConversation"
                );
                state.commandUndefined = origin.goDoCommand(
                    "cmd_openConversation"
                ) === undefined;
            }
            """,
            script_args=[self.fixture["expected"][2], cancel],
        )
        try:
            Wait(self.marionette).until(
                lambda driver: driver.execute_script(
                    """
                    const state = window.conversation097;
                    if (state.error) {
                        return true;
                    }
                    if (state.cancel) {
                        return state.completionCount == 1 &&
                            state.created && state.created.closed;
                    }
                    if (!state.started) {
                        return false;
                    }
                    return state.tabmail.tabInfo.some(tab => {
                        if (state.baseline.includes(tab)) {
                            return false;
                        }
                        const pane = tab.chromeBrowser?.contentWindow;
                        return pane?.gViewWrapper?.isSynthetic &&
                            pane.dbViewWrapperListener.allMessagesLoaded &&
                            pane.gDBView?.numSelected == 1;
                    });
                    """
                )
            )
            result = self.marionette.execute_script(
                """
                const state = window.conversation097;
                if (state.error) {
                    return { error: state.error };
                }
                const result = {
                    disabled: state.disabled, enabled: state.enabled,
                    windowEvents: state.windowEvents,
                    mainWindows: [...Services.wm.getEnumerator("mail:3pane")].length,
                    originClosed: state.origin.closed,
                    createdClosed: state.created.closed,
                    openedTabs: state.openedTabs,
                };
                if (state.cancel) {
                    return { ...result, isPromise: state.isPromise,
                        cancelled: state.cancelled,
                        completionCount: state.completionCount,
                        lateSuccess: state.lateSuccess,
                        startupReached: state.started !== null };
                }
                const tabs = state.tabmail.tabInfo.filter(
                    tab => !state.baseline.includes(tab)
                );
                const tab = tabs[0];
                const pane = tab.chromeBrowser.contentWindow;
                const physical = header => ({
                    folderURI: header.folder.URI,
                    key: header.messageKey,
                    messageId: header.messageId,
                });
                return { ...result,
                    commandUndefined: state.commandUndefined,
                    windowType: state.created.document.documentElement
                        .getAttribute("windowtype"),
                    startupMatches: state.started == state.created,
                    newTabs: tabs.length, mode: tab.mode.name,
                    rows: Array.from({ length: pane.gDBView.rowCount }, (_, i) =>
                        physical(pane.gDBView.getMsgHdrAt(i))),
                    selected: physical(pane.gDBView.hdrForFirstSelectedMessage),
                };
                """
            )
            self.logger.info("Conversation097 actual " + json.dumps(result))
            return result
        except Exception:
            pending = self.marionette.execute_script(
                """
                const state = window.conversation097;
                return {
                    windowEvents: state.windowEvents,
                    controllerFound: state.controllerFound,
                    commandUndefined: state.commandUndefined,
                    created: state.created !== null,
                    createdClosed: state.created?.closed,
                    createdType: state.created && !state.created.closed
                        ? state.created.document.documentElement.getAttribute("windowtype")
                        : null,
                    startupMatches: state.started == state.created,
                    mainWindows: [...Services.wm.getEnumerator("mail:3pane")].length,
                    originClosed: state.origin.closed,
                    openedTabs: state.openedTabs,
                    tabs: state.tabmail ? state.tabmail.tabInfo.map(tab => {
                        const pane = tab.chromeBrowser?.contentWindow;
                        return { mode: tab.mode.name,
                            baseline: state.baseline.includes(tab),
                            synthetic: pane?.gViewWrapper?.isSynthetic,
                            loaded: pane?.dbViewWrapperListener?.allMessagesLoaded,
                            rows: pane?.gDBView?.rowCount,
                            selected: pane?.gDBView?.numSelected };
                    }) : [],
                };
                """
            )
            self.logger.info("Conversation097 failure state " + json.dumps(pending))
            raise
        finally:
            self.marionette.execute_script(
                """
                const state = window.conversation097;
                Services.ww.unregisterNotification(state.observer);
                if (state.created && !state.created.closed) {
                    state.created.removeEventListener("unload", state.onUnload);
                }
                Services.obs.removeObserver(state.startup, "mail-startup-done");
                if (state.tabmail && !state.created.closed) {
                    state.tabmail.tabContainer.removeEventListener("TabOpen", state.onTab);
                }
                delete window.conversation097;
                """
            )

    def test_open_without_main_window(self):
        result = self.open_conversation(False)
        self.assertNotIn("error", result, result)
        self.assertTrue(result["disabled"])
        self.assertTrue(result["enabled"])
        self.assertTrue(result["commandUndefined"])
        self.assertFalse(result["originClosed"])
        self.assertFalse(result["createdClosed"])
        self.assertEqual(1, result["newTabs"])
        self.assertEqual(1, result["openedTabs"])
        self.assertEqual("mail:3pane", result["windowType"])
        self.assertTrue(result["startupMatches"])
        self.assertEqual(1, result["mainWindows"])
        self.assertEqual("mail3PaneTab", result["mode"])
        self.assertEqual(
            sorted(self.fixture["expected"], key=lambda row: row["key"]),
            sorted(result["rows"], key=lambda row: row["key"]),
        )
        self.assertEqual(self.fixture["expected"][2], result["selected"])

    def test_cancel_during_new_main_window_startup(self):
        result = self.open_conversation(True)
        self.assertNotIn("error", result, result)
        self.assertTrue(result["isPromise"])
        self.assertTrue(result["cancelled"])
        self.assertEqual(1, result["completionCount"])
        self.assertFalse(result["lateSuccess"])
        self.assertFalse(result["startupReached"])
        self.assertEqual(0, result["openedTabs"])
        self.assertTrue(result["originClosed"])
        self.assertTrue(result["createdClosed"])
        self.assertEqual(0, result["mainWindows"])

    def restore(self):
        """Restore real windows, fixture folders and original startup preferences."""
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        handles = self.marionette.chrome_window_handles
        if handles:
            self.marionette.switch_to_window(
                self.activity if self.activity in handles else handles[0]
            )
            if not self.main_window_count():
                self.open_window(
                    r"""
                    Services.ww.openWindow(null, "chrome://messenger/content/messenger.xhtml",
                        "_blank", "chrome,dialog=no,all",
                        Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString));
                    """,
                    "mail:3pane",
                )
            Wait(self.marionette).until(
                lambda driver: driver.execute_script(
                    "return [...Services.wm.getEnumerator('mail:3pane')].every("
                    "win => win.document.getElementById('tabmail')?.tabInfo?.length > 0);"
                )
            )
            self.marionette.execute_script(
                r"""
                for (const win of Services.wm.getEnumerator("mail:3pane")) {
                    win.document.getElementById("tabmail").closeOtherTabs(0);
                }
                """
            )
            if self.origin in self.marionette.chrome_window_handles:
                self.marionette.switch_to_window(self.origin)
                self.marionette.close_chrome_window()
            handles = self.marionette.chrome_window_handles
            self.marionette.switch_to_window(handles[0])
            if self.fixture:
                result = self.marionette.execute_async_script(
                    r"""
                    const [fixture] = arguments;
                    const done = arguments[arguments.length - 1];
                    (async () => {
                        const { MailServices } = ChromeUtils.importESModule(
                            "resource:///modules/MailServices.sys.mjs"
                        );
                        const { closeMailSearch } = ChromeUtils.importESModule(
                            "resource:///modules/panorama/MailSearch.sys.mjs"
                        );
                        await closeMailSearch();
                        for (const uri of fixture.folders) {
                            const folder = MailServices.folderLookup.getFolderForURL(uri);
                            folder.parent.propagateDelete(folder, true);
                        }
                        if (fixture.accountKey) {
                            MailServices.accounts.removeAccount(
                                MailServices.accounts.getAccount(fixture.accountKey), false);
                        }
                    })().then(() => done(null), error => done(String(error)));
                    """,
                    script_args=[self.fixture],
                )
                self.assertIsNone(result, result)
            if self.activity in self.marionette.chrome_window_handles:
                self.marionette.switch_to_window(self.activity)
                self.marionette.close_chrome_window()
            self.marionette.switch_to_window(self.marionette.chrome_window_handles[0])
        self.marionette.instance.prefs = self.instance_prefs
        for name, previous in self.saved_prefs.items():
            if previous["user"]:
                self.marionette.set_pref(name, previous["value"])
            else:
                self.marionette.clear_pref(name)
        if self.saved_prefs:
            # Keep the same profile; restore startup backend selection too.
            self.marionette.restart(in_app=True, clean=False)
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
