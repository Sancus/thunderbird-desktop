# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, you can obtain one at http://mozilla.org/MPL/2.0/.

import json
import shutil
from pathlib import Path

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
            self.restore()
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
                windowEvents: [], createdClosedObserved: false,
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
                    if (topic == "domwindowopened" && !state.created) {
                        state.created = subject;
                        subject.addEventListener("unload", state.onUnload);
                        if (cancel == "created") {
                            subject.close();
                        } else if (cancel) {
                            origin.close();
                        }
                    } else if (topic == "domwindowclosed" && subject == state.created) {
                        state.createdClosedObserved = true;
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
                            state.created && state.created.closed &&
                            (state.cancel != "created" || state.createdClosedObserved);
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
                        startupReached: state.started !== null,
                        createdClosedObserved: state.createdClosedObserved };
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
            if cancel == "created" and "error" not in result:
                # Exercise the next ordinary startup before releasing the old request.
                self.marionette.execute_script(
                    """
                    const state = window.conversation097;
                    state.recoveryStartup = null;
                    state.recoveryStartupObserver = subject => {
                        state.recoveryStartup = subject;
                    };
                    Services.obs.addObserver(state.recoveryStartupObserver, "mail-startup-done");
                    """
                )
                try:
                    self.open_window(
                        r"""
                        Services.ww.openWindow(null, "chrome://messenger/content/messenger.xhtml",
                            "_blank", "chrome,dialog=no,all",
                            Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString));
                        """,
                        "mail:3pane",
                    )
                finally:
                    self.marionette.switch_to_window(self.activity)
                Wait(self.marionette).until(
                    lambda driver: driver.execute_script(
                        """
                        const win = window.conversation097.recoveryStartup;
                        return win && win.document.getElementById("tabmail")?.tabInfo?.length > 0;
                        """
                    )
                )
                result["recovery"] = self.marionette.execute_script(
                    """
                    const state = window.conversation097;
                    const win = Services.wm.getMostRecentWindow("mail:3pane");
                    const tabs = win.document.getElementById("tabmail").tabInfo;
                    const view = state.origin.messageBrowser.contentWindow.gDBView;
                    const header = view.hdrForFirstSelectedMessage;
                    return {
                        startupMatches: state.recoveryStartup == win,
                        mainWindows: [...Services.wm.getEnumerator("mail:3pane")].length,
                        tabs: tabs.length,
                        syntheticTabs: tabs.filter(tab =>
                            tab.chromeBrowser?.contentWindow?.gViewWrapper?.isSynthetic).length,
                        completionCount: state.completionCount,
                        lateSuccess: state.lateSuccess,
                        error: state.error ?? null,
                        originClosed: state.origin.closed,
                        selectedCount: view.numSelected,
                        selected: { folderURI: header.folder.URI,
                            key: header.messageKey, messageId: header.messageId },
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
                if (state.recoveryStartupObserver) {
                    Services.obs.removeObserver(state.recoveryStartupObserver, "mail-startup-done");
                }
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

    def test_new_main_window_closed_before_startup(self):
        result = self.open_conversation("created")
        self.assertNotIn("error", result, result)
        self.assertTrue(result["disabled"])
        self.assertTrue(result["enabled"])
        self.assertTrue(result["isPromise"])
        self.assertTrue(result["cancelled"])
        self.assertEqual(1, result["completionCount"])
        self.assertFalse(result["lateSuccess"])
        self.assertFalse(result["startupReached"])
        self.assertEqual(0, result["openedTabs"])
        self.assertFalse(result["originClosed"])
        self.assertTrue(result["createdClosed"])
        self.assertTrue(result["createdClosedObserved"])
        self.assertEqual(0, result["mainWindows"])
        recovery = result["recovery"]
        self.assertTrue(recovery["startupMatches"])
        self.assertEqual(1, recovery["mainWindows"])
        self.assertEqual(1, recovery["tabs"])
        self.assertEqual(0, recovery["syntheticTabs"])
        self.assertEqual(1, recovery["completionCount"])
        self.assertFalse(recovery["lateSuccess"])
        self.assertIsNone(recovery["error"])
        self.assertFalse(recovery["originClosed"])
        self.assertEqual(1, recovery["selectedCount"])
        self.assertEqual(self.fixture["expected"][2], recovery["selected"])

    def search_lifecycle(self, action, *args):
        """Call the installed test module outside closing window globals."""
        uri = (Path(__file__).parent / "scripts" / "search_lifecycle.sys.mjs").resolve().as_uri()
        result = self.marionette.execute_async_script(
            """
            const [uri, action, ...values] = arguments;
            const done = arguments[arguments.length - 1];
            // The final Marionette callback is not an action argument.
            values.pop();
            (async () => {
                const file = Services.io.newURI(uri).QueryInterface(Ci.nsIFileURL).file;
                if (!file.exists() || !file.isFile() || file.leafName != "search_lifecycle.sys.mjs") {
                    throw new Error("The ordinary installed lifecycle payload is missing");
                }
                const handler = Services.io.getProtocolHandler("resource")
                    .QueryInterface(Ci.nsIResProtocolHandler);
                const name = "panorama-lifecycle-test";
                const previous = handler.hasSubstitution(name) ? handler.getSubstitution(name) : null;
                try {
                    handler.setSubstitution(name, Services.io.newFileURI(file.parent));
                    const module = ChromeUtils.importESModule(
                        "resource://panorama-lifecycle-test/search_lifecycle.sys.mjs");
                    return await module[action](...values);
                } finally {
                    handler.setSubstitution(name, previous);
                }
            })().then(
                value => done({ value }),
                error => done({ error: String(error), stack: error.stack })
            );
            """,
            script_args=[uri, action, *args],
        )
        self.assertNotIn("error", result, result)
        return result["value"]

    def test_native_search_preferences_and_activity(self):
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
                'return window.document.getElementById("tabmail")?.tabInfo?.length > 0;'
            )
        )
        opened = self.marionette.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            window.openPreferencesTab("paneGeneral", "enableGloda").then(
                () => done(null), error => done(String(error)));
            """
        )
        self.assertIsNone(opened, opened)
        selection = self.fixture["expected"][2]
        try:
            for enabled in [False, True]:
                self.marionette.execute_script(
                    """
                    const browser = window.document.getElementById("tabmail").currentTabInfo.browser;
                    const checkbox = browser.contentDocument.getElementById("enableGloda");
                    if (checkbox.checked != !arguments[0]) {
                        throw new Error("Preferences must start in the opposite state");
                    }
                    checkbox.click();
                    """,
                    script_args=[enabled],
                )
                Wait(self.marionette).until(
                    lambda driver: driver.execute_script(
                        """
                        const browser = window.document.getElementById("tabmail").currentTabInfo.browser;
                        return browser.contentDocument.getElementById("enableGloda").checked == arguments[0] &&
                            Services.prefs.getBoolPref("mailnews.database.global.indexer.enabled") == arguments[0];
                        """,
                        script_args=[enabled],
                    )
                )
                policy = self.search_lifecycle("policy", selection)
                self.assertEqual(enabled, policy["eligible"])
                self.assertEqual("eligible" if enabled else "disabled", policy["reason"])
            result = self.search_lifecycle("observeActivity", selection)
            self.logger.info("S422 activity actual " + json.dumps(result))
            self.assertTrue(result["sourceId"])
            self.assertGreaterEqual(result["unavailable"], 1)
            self.assertEqual(selection, result["physical"])
            self.assertFalse(result["text"]["bodyIndexed"])
            self.assertEqual(1, result["activityCount"])
            self.assertTrue(result["waiting"])
            self.assertEqual(-1, result["percent"])
            self.assertTrue(result["status"])
            closed = self.search_lifecycle("finishActivity")
            self.assertTrue(closed["tokenRestored"])
            self.assertTrue(closed["cancelled"])
            self.assertEqual(0, closed["remaining"])
        finally:
            self.search_lifecycle("finishActivity")

    def test_quit_with_pending_native_search_open(self):
        receipt_name = "s422-quit-receipt.json"
        armed = self.search_lifecycle("armQuit", receipt_name)
        self.assertEqual(1, armed["opens"])
        self.assertEqual([0, 0], armed["callbacks"])
        self.assertTrue(armed["sourceId"])
        old_pid = self.marionette.execute_script("return Services.appinfo.processID;")
        profile = self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )
        capabilities = self.marionette.requested_capabilities
        try:
            details = self.marionette.quit(in_app=True, clean=False)
            self.assertTrue(details["in_app"])
            self.assertFalse(details["forced"])
            self.assertEqual("shutdown", details["cause"])
            self.assertEqual(0, self.marionette.instance.runner.returncode)
            result = json.loads(Path(armed["receiptPath"]).read_text(encoding="utf-8"))
            self.logger.info("S422 quit actual " + json.dumps(result))
            self.assertNotIn("error", result, result)
            self.assertEqual([], result["errors"])
            self.assertEqual(armed["sourceId"], result["sourceId"])
            self.assertEqual(1, result["opens"])
            self.assertEqual([1, 1], result["callbacks"])
            self.assertEqual([True, True], result["sameService"])
            self.assertEqual(1, result["quitObserved"])
            self.assertEqual(1, result["profileObserved"])
            self.assertTrue(result["pendingAtQuit"])
            self.assertTrue(result["shuttingDown"])
            self.assertEqual([True, True], result["lateRejected"])
            self.assertTrue(result["drained"])
            self.assertTrue(result["closePromisesSame"])
            self.assertTrue(result["closedUpdateRejected"])
            self.assertEqual(0, result["activities"])
        finally:
            if (
                self.marionette.instance.runner.returncode is not None
                and not self.marionette.session
            ):
                self.marionette.start_session(capabilities)
                # Window handles belong to the exited process, even if an ID is reused.
                self.origin = None
                self.activity = None
                self.marionette.set_context(self.marionette.CONTEXT_CHROME)
                self.marionette.switch_to_window(self.marionette.chrome_window_handles[0])
            elif self.marionette.session:
                self.search_lifecycle("cancelQuit")
            Path(armed["receiptPath"]).unlink(missing_ok=True)
        self.assertNotEqual(
            old_pid, self.marionette.execute_script("return Services.appinfo.processID;")
        )
        self.assertEqual(
            profile,
            self.marionette.execute_script(
                "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
            ),
        )

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


class TestPanoramaAppWrittenDelimiterMigration(MarionetteTestCase):
    """Migrate app-written IMAP client folders whose delimiter is unknown or NIL.

    Sorted before TestPanoramaConversation so it starts from the healthy runner
    profile; tearDown leaves a fresh clean profile for the next class.
    """

    def setUp(self):
        super().setUp()
        self.instance_prefs = self.marionette.instance.prefs
        self.work = []
        self.restart_clean({"mail.panorama.enabled": False})

    def tearDown(self):
        try:
            self.restart_clean({})
            for path in self.work:
                shutil.rmtree(path, ignore_errors=True)
        finally:
            super().tearDown()

    def restart_clean(self, prefs):
        """Use the ordinary runner after a normal quit, with a fresh profile."""
        if self.marionette.session:
            self.marionette.set_context(self.marionette.CONTEXT_CHROME)
            self.marionette.quit(in_app=True)
        self.marionette.instance.restart(
            prefs={**(self.instance_prefs or {}), **prefs}, clean=True
        )
        self.marionette.raise_for_port(timeout=self.marionette.startup_timeout)
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.profile = Path(
            self.marionette.execute_script(
                "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
            )
        ).resolve()

    def stop(self):
        """Quit normally; the application writes its folder cache on exit."""
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        self.marionette.execute_script("Services.prefs.savePrefFile(null);")
        self.marionette.quit(in_app=True)

    def start(self, enabled):
        """Start the same stopped profile with the pref."""
        self.marionette.instance.profile.set_preferences(
            {"mail.panorama.enabled": enabled}
        )
        self.marionette.start_session()
        self.marionette.set_context(self.marionette.CONTEXT_CHROME)
        selected = self.marionette.execute_script(
            "return Services.dirsvc.get('ProfD', Ci.nsIFile).path;"
        )
        self.assertEqual(self.profile, Path(selected).resolve())
        self.assertEqual(enabled, self.marionette.get_pref("mail.panorama.enabled"))

    def selection(self):
        """Read the durable backend selector after ordinary opted-in startup."""
        result = self.marionette.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            (async () => {
              const { MailGlue } = ChromeUtils.importESModule(
                "resource:///modules/MailGlue.sys.mjs");
              await MailGlue.panoramaStartup;
              const record = await IOUtils.readJSON(PathUtils.join(
                Services.dirsvc.get("ProfD", Ci.nsIFile).path,
                "panorama-profile.json"));
              const core = Cc["@mozilla.org/mailnews/database-core;1"]
                .getService(Ci.nsIDatabaseCore);
              return { record, sourceId: core.sourceId };
            })().then(done, error => done({ error: String(error) }));
            """
        )
        self.assertNotIn("error", result)
        record = result["record"]
        self.assertEqual("active", record["state"])
        self.assertEqual("panorama", record["backend"])
        self.assertEqual(result["sourceId"], record["identity"]["databaseSourceId"])
        if record["identity"]["backup"]:
            self.work.append(Path(record["identity"]["backup"]["path"]).parent.parent)
        return result

    def folders(self, key, names=("INBOX", "Junk", "Flat")):
        return self.marionette.execute_script(
            """
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs");
            const server = MailServices.accounts.getIncomingServer(arguments[0]);
            return Object.fromEntries(arguments[1].map(name => {
              const folder = server.rootFolder.getChildNamed(name);
              const imap = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
              return [name, {
                onlineName: imap.onlineName,
                delimiter: imap.hierarchyDelimiter.charCodeAt(0),
                messages: [...folder.msgDatabase.enumerateMessages()].map(
                  header => [header.messageKey, header.messageId,
                    header.getUint32Property("uidOnServer")]),
              }];
            }));
            """,
            script_args=[key, list(names)],
        )

    def test_migratesClientFoldersWithUnknownOrNilDelimiterThenReuses(self):
        def without_keys(folders):
            return {
                name: {**value, "messages": [m[1:] for m in value["messages"]]}
                for name, value in folders.items()
            }

        source = self.marionette.execute_script(
            """
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs");
            Services.io.offline = true;
            Services.prefs.setBoolPref("network.manage-offline-status", false);
            Services.prefs.setIntPref("offline.startup_state", 2);
            const server = MailServices.accounts.createIncomingServer(
              "s526delim", "imap.invalid", "imap");
            server.setBoolValue("login_at_startup", false);
            server.setBoolValue("download_on_biff", false);
            MailServices.accounts.createAccount().incomingServer = server;
            const root = server.rootFolder.QueryInterface(Ci.nsIMsgImapMailFolder);
            const summaries = {};
            // INBOX was listed with "/"; Junk and Flat are client folders the
            // server never listed, so Thunderbird keeps the "^"/"|" sentinel.
            const folders = [["INBOX", "/"], ["Junk", "^"], ["Flat", "|"]];
            for (const [index, [name, delimiter]] of folders.entries()) {
              if (!root.containsChildNamed(name)) {
                root.createClientSubfolderInfo(name, delimiter, 0, true);
              }
              const folder = server.rootFolder.getChildNamed(name);
              // A new server already has a client INBOX with an unknown
              // delimiter; record the listed "/" like a server LIST would.
              folder.QueryInterface(Ci.nsIMsgImapMailFolder).hierarchyDelimiter =
                delimiter;
              const database = folder.msgDatabase;
              database.dBFolderInfo.setUint32Property("UIDValidity", 94);
              const header = database.createNewHdrWithSpecificMsgKey(40 + index);
              header.messageId = name + "-delimiter-s526@invalid";
              header.subject = "Retained " + name;
              header.setUint32Property("uidOnServer", 40 + index);
              database.addNewHdrToDB(header, false);
              database.summaryValid = true;
              database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
              summaries[name] = folder.summaryFile.path;
            }
            Services.prefs.savePrefFile(null);
            return { key: server.key, summaries };
            """
        )
        legacy = self.folders(source["key"])
        self.assertEqual(
            {"INBOX": 47, "Junk": 94, "Flat": 124},
            {name: value["delimiter"] for name, value in legacy.items()},
        )
        # A normal quit lets the real application write its folder cache,
        # then the stopped legacy profile restarts opted in, as in S7-11.
        self.stop()
        cache = self.profile / "folderCache.json"
        rows = json.loads(cache.read_text(encoding="utf-8"))
        for name, delimiter in [("INBOX", 47), ("Junk", 94), ("Flat", 124)]:
            row = rows[source["summaries"][name]]
            self.assertEqual((name, delimiter), (row["onlineName"], row["hierDelim"]))
        originals = {
            path: Path(path).read_bytes()
            for path in [str(cache), *source["summaries"].values()]
        }
        self.start(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(3, len(selected["record"]["identity"]["imports"]))
        migrated = self.folders(source["key"])
        # Native import assigns its own message keys; names, delimiters,
        # Message-IDs and server UIDs are retained exactly.
        self.assertEqual(without_keys(legacy), without_keys(migrated))
        for path, data in originals.items():
            self.assertEqual(data, Path(path).read_bytes(), path)
        self.stop()
        self.start(True)
        repeated = self.selection()
        self.assertEqual(selected["sourceId"], repeated["sourceId"])
        self.assertEqual(selected["record"]["identity"], repeated["record"]["identity"])
        self.assertEqual(migrated, self.folders(source["key"]))
        for path, data in originals.items():
            self.assertEqual(data, Path(path).read_bytes(), path)

    def test_migratesSummaryOnlyImapFoldersBesideOfflineStoresThenReuses(self):
        def without_keys(folders):
            return {
                name: {**value, "messages": [m[1:] for m in value["messages"]]}
                for name, value in folders.items()
            }

        # Two servers make the check independent of directory order: each
        # server's offline INBOX store is visited beside the other server's
        # summary-only Trash, which has no offline store yet.
        sources = self.marionette.execute_script(
            """
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs");
            Services.io.offline = true;
            Services.prefs.setBoolPref("network.manage-offline-status", false);
            Services.prefs.setIntPref("offline.startup_state", 2);
            const result = ["s526targeta", "s526targetb"].map((user, server_index) => {
              const server = MailServices.accounts.createIncomingServer(
                user, "imap.invalid", "imap");
              server.setBoolValue("login_at_startup", false);
              server.setBoolValue("download_on_biff", false);
              MailServices.accounts.createAccount().incomingServer = server;
              const root = server.rootFolder.QueryInterface(Ci.nsIMsgImapMailFolder);
              const paths = {};
              for (const [index, name] of ["INBOX", "Trash"].entries()) {
                if (!root.containsChildNamed(name)) {
                  root.createClientSubfolderInfo(name, "/", 0, true);
                }
                const folder = server.rootFolder.getChildNamed(name);
                folder.QueryInterface(Ci.nsIMsgImapMailFolder).hierarchyDelimiter =
                  "/";
                const database = folder.msgDatabase;
                database.dBFolderInfo.setUint32Property("UIDValidity", 526);
                const key = 60 + 10 * server_index + index;
                const header = database.createNewHdrWithSpecificMsgKey(key);
                header.messageId = user + "-" + name + "-target-s526@invalid";
                header.subject = "Retained " + name;
                header.setUint32Property("uidOnServer", key);
                database.addNewHdrToDB(header, false);
                database.summaryValid = true;
                database.commit(Ci.nsMsgDBCommitType.kLargeCommit);
                if (name == "INBOX") {
                  // The ordinary store API creates the offline INBOX store.
                  folder.msgStore.ensureLocalStore(folder);
                }
                paths[name] = {
                  summary: folder.summaryFile.path,
                  store: folder.filePath.path,
                };
              }
              // Like Thunderbird's junk destination lookup, attach a client
              // Junk folder without box state; the server never listed it.
              const junk = server.rootFolder.addSubfolder("Junk");
              junk.setFlag(Ci.nsMsgFolderFlags.Junk);
              junk.msgDatabase.summaryValid = true;
              junk.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
              paths.Junk = { summary: junk.summaryFile.path, flags: junk.flags };
              return { key: server.key, paths };
            });
            Services.prefs.savePrefFile(null);
            return result;
            """
        )
        names = ("INBOX", "Trash", "Junk")
        for source in sources:
            # Thunderbird keeps no box state for its never-listed client Junk.
            flags = source["paths"]["Junk"]["flags"]
            self.assertEqual(0x40000000, flags & 0x40000000, flags)
            self.assertEqual(0, flags & 0x2000, flags)
        legacy = {s["key"]: self.folders(s["key"], names) for s in sources}
        # A normal quit writes the cache; the stopped profile restarts opted in.
        self.stop()
        rows = json.loads((self.profile / "folderCache.json").read_text(encoding="utf-8"))
        for source in sources:
            row = rows[source["paths"]["Junk"]["summary"]]
            self.assertEqual(("Junk", 94, 0), (row["onlineName"], row["hierDelim"], row["boxFlags"]))
            self.assertEqual(0x40000000, row["flags"] & 0x40000000, row)
            self.assertEqual(0, row["flags"] & 0x2000, row)
        originals = {str(self.profile / "folderCache.json"): None}
        for source in sources:
            inbox, trash = source["paths"]["INBOX"], source["paths"]["Trash"]
            self.assertTrue(Path(inbox["store"]).is_file(), inbox["store"])
            self.assertFalse(Path(trash["store"]).exists(), trash["store"])
            originals.update(
                {inbox["store"]: None, inbox["summary"]: None, trash["summary"]: None}
            )
            originals[source["paths"]["Junk"]["summary"]] = None
        originals = {path: Path(path).read_bytes() for path in originals}
        self.start(True)
        selected = self.selection()
        self.assertEqual("migrated", selected["record"]["origin"])
        self.assertEqual(6, len(selected["record"]["identity"]["imports"]))
        migrated = {s["key"]: self.folders(s["key"], names) for s in sources}
        self.assertEqual(
            {key: without_keys(value) for key, value in legacy.items()},
            {key: without_keys(value) for key, value in migrated.items()},
        )
        for path, data in originals.items():
            self.assertEqual(data, Path(path).read_bytes(), path)
        self.stop()
        self.start(True)
        repeated = self.selection()
        self.assertEqual(selected["sourceId"], repeated["sourceId"])
        self.assertEqual(selected["record"]["identity"], repeated["record"]["identity"])
        self.assertEqual(
            migrated, {s["key"]: self.folders(s["key"], names) for s in sources}
        )
        for path, data in originals.items():
            self.assertEqual(data, Path(path).read_bytes(), path)
