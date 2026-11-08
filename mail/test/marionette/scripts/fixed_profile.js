/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global arguments */

// Chrome-context actions for test_panorama_fixed_profile.py. Each call runs
// one named action and resolves with plain JSON describing real state.
const [action, args] = arguments;
const done = arguments[arguments.length - 1];
const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const win = Services.wm.getMostRecentWindow("mail:3pane");

const UIDVALIDITY = 7110;
const IMAP_MESSAGES = {
  fresh: [
    {
      messageId: "s711-fresh-imap@example.invalid",
      subject: "S711 fresh received message",
      from: "S711 Sender <s711-sender@example.invalid>",
      to: "S711 Reader <s711-reader@example.invalid>",
      body: "S711 fresh received body text.",
    },
  ],
  migrated: [
    {
      messageId: "s711-migrated-imap@example.invalid",
      subject: "S711 s711migratedneedle IMAP message",
      from: "S711 IMAP Sender <s711-imap-sender@example.invalid>",
      to: "S711 Reader <s711-reader@example.invalid>",
      body: "S711 migrated IMAP body text.",
    },
  ],
};
const LOCAL_THREAD = [
  {
    messageId: "s711-migrated-root@example.invalid",
    subject: "S711 s711migratedneedle local thread",
    from: "S711 Root Sender <s711-root@example.invalid>",
    to: "S711 Reader <s711-reader@example.invalid>",
    body: "S711 migrated local root body.",
  },
  {
    messageId: "s711-migrated-reply@example.invalid",
    references: "<s711-migrated-root@example.invalid>",
    subject: "Re: S711 s711migratedneedle local thread",
    from: "S711 Reply Sender <s711-reply@example.invalid>",
    to: "S711 Root Sender <s711-root@example.invalid>",
    body: "S711 migrated local reply body.",
  },
];

/**
 * Builds one RFC 5322 message from a fixed description.
 *
 * @param {object} m - Message fields.
 * @returns {string} Message text with CRLF line endings.
 */
function messageText(m) {
  return [
    `From: ${m.from}`,
    `To: ${m.to}`,
    "Date: Sun, 08 Nov 2026 12:00:00 +0000",
    `Subject: ${m.subject}`,
    `Message-ID: <${m.messageId}>`,
    ...(m.references
      ? [`References: ${m.references}`, `In-Reply-To: ${m.references}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    m.body,
    "",
  ].join("\r\n");
}

/**
 * Registers the installed test modules for this application process, as
 * send_later.js does.
 */
function registerModules() {
  const handler = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  if (win.s711Modules) {
    return;
  }
  let root = Services.dirsvc.get("GreD", Ci.nsIFile);
  for (let depth = 0; root && depth < 5; depth++, root = root.parent) {
    for (const layout of ["_tests", "tests"]) {
      const modules = root.clone();
      modules.append(layout);
      modules.append("modules");
      const has = name => {
        const file = modules.clone();
        file.append("mailnews");
        file.append(name);
        return file.exists();
      };
      if (["Imapd.sys.mjs", "Maild.sys.mjs", "IMAPServer.sys.mjs"].every(has)) {
        win.s711Modules = {
          previous: handler.hasSubstitution("testing-common")
            ? handler.getSubstitution("testing-common")
            : null,
        };
        handler.setSubstitution(
          "testing-common",
          Services.io.newFileURI(modules)
        );
        return;
      }
    }
  }
  throw new Error(
    "The ordinary installed test modules/mailnews payload is missing"
  );
}

/** Stops this process's IMAP server and restores the resource mapping. */
function stopServer() {
  if (win.s711Imap) {
    win.s711Imap.close();
    delete win.s711Imap;
  }
  if (win.s711Modules) {
    Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler)
      .setSubstitution("testing-common", win.s711Modules.previous);
    delete win.s711Modules;
  }
}

/**
 * Starts a real IMAP server whose INBOX holds the fixed messages.
 *
 * @param {string} set - Key into IMAP_MESSAGES.
 * @returns {object} The running IMAPServer.
 */
function startServer(set) {
  registerModules();
  const { IMAPServer } = ChromeUtils.importESModule(
    "resource://testing-common/mailnews/IMAPServer.sys.mjs"
  );
  const server = (win.s711Imap = new IMAPServer());
  const inbox = server.daemon.getMailbox("INBOX");
  inbox.uidvalidity = UIDVALIDITY;
  server.addMessages(
    "INBOX",
    IMAP_MESSAGES[set].map(m => messageText(m)),
    false
  );
  return server;
}

/**
 * Waits for a URL-listener based folder operation.
 *
 * @param {Function} start - Called with an nsIUrlListener.
 */
function urlOperation(start) {
  return new Promise((resolve, reject) => {
    start({
      QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
      OnStartRunningUrl() {},
      OnStopRunningUrl(url, status) {
        Components.isSuccessCode(status)
          ? resolve()
          : reject(Components.Exception("Folder operation failed", status));
      },
    });
  });
}

/**
 * Creates the IMAP account for the running server and synchronizes INBOX.
 *
 * @param {boolean} offline - Also download INBOX bodies for offline use.
 * @returns {Promise<nsIMsgFolder>} Synchronized INBOX.
 */
async function createImapAccount(offline) {
  const incoming = MailServices.accounts.createIncomingServer(
    "user",
    "localhost",
    "imap"
  );
  incoming.port = win.s711Imap.port;
  incoming.password = "password";
  incoming.setBoolValue("login_at_startup", false);
  incoming.setBoolValue("download_on_biff", false);
  incoming.QueryInterface(Ci.nsIImapIncomingServer).maximumConnectionsNumber =
    1;
  incoming.useIdle = false;
  incoming.setBoolValue("autosync_offline_stores", false);
  const account = MailServices.accounts.createAccount();
  account.incomingServer = incoming;
  const identity = MailServices.accounts.createIdentity();
  identity.email = "s711-reader@example.invalid";
  account.addIdentity(identity);
  await urlOperation(listener =>
    MailServices.imap.discoverAllFolders(incoming.rootFolder, listener, null)
  );
  const inbox = incoming.rootFolder
    .getChildNamed("INBOX")
    .QueryInterface(Ci.nsIMsgImapMailFolder);
  await urlOperation(listener =>
    inbox.updateFolderWithListener(null, listener)
  );
  if (offline) {
    await urlOperation(listener => inbox.downloadAllForOffline(listener, null));
  }
  return inbox;
}

/** @returns {nsIMsgLocalMailFolder} The Local Folders root, created if needed. */
function localRoot() {
  // The localFoldersServer getter throws until a Local Folders account exists.
  let server = [...MailServices.accounts.allServers].find(
    s => s.type == "none"
  );
  if (!server) {
    MailServices.accounts.createLocalMailAccount();
    server = MailServices.accounts.localFoldersServer;
  }
  return server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
}

/**
 * Reads one header's real stored message text.
 *
 * @param {nsIMsgDBHdr} header - Stored header.
 * @returns {string} Raw stored text, or null when no local body exists.
 */
function rawText(header) {
  let input;
  try {
    input = header.folder.getMsgInputStream(header);
  } catch {
    return null;
  }
  const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
    Ci.nsIScriptableInputStream
  );
  stream.init(input);
  let remaining = header.messageSize;
  let raw = "";
  try {
    while (remaining > 0) {
      const part = stream.read(Math.min(remaining, 4096));
      if (!part.length) {
        break;
      }
      raw += part;
      remaining -= part.length;
    }
  } finally {
    stream.close();
  }
  return raw;
}

/**
 * Returns real header identities and bodies of each folder.
 *
 * @param {string[]} uris - Folder URIs.
 * @returns {object} Backend identity and per-folder messages in key order.
 */
function snapshot(uris) {
  const backend = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const folders = {};
  for (const uri of uris) {
    const folder = MailServices.folderLookup.getFolderForURL(uri);
    folders[uri] = folder
      ? [...folder.messages]
          .map(header => ({
            key: header.messageKey,
            messageId: header.messageId,
            subject: header.mime2DecodedSubject,
            author: header.mime2DecodedAuthor,
            recipients: header.mime2DecodedRecipients,
            raw: rawText(header),
          }))
          .sort((a, b) => a.key - b.key)
      : null;
  }
  return {
    native: "nsIDatabaseCore" in Ci && backend instanceof Ci.nsIDatabaseCore,
    enabled: Services.prefs.getBoolPref("mail.panorama.enabled"),
    pid: Services.appinfo.processID,
    folders,
  };
}

/**
 * Waits for a condition in this process without loading test modules.
 *
 * @param {Function} condition - Returns a truthy value when done.
 * @param {string} message - Failure description.
 * @param {number} [interval=100] - Milliseconds between checks.
 * @param {number} [tries=600] - Maximum number of checks.
 */
async function waitFor(condition, message, interval = 100, tries = 600) {
  for (let i = 0; i < tries; i++) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => win.setTimeout(resolve, interval));
  }
  throw new Error("Timed out: " + message);
}

/** @returns {Window} The first tab's about:3pane window. */
function about3Pane() {
  const tabmail = win.document.getElementById("tabmail");
  tabmail.switchToTab(0);
  return tabmail.currentAbout3Pane;
}

/**
 * Shows one folder in the first mail tab and selects one message.
 *
 * @param {string} uri - Folder URI.
 * @param {string} messageId - Message-ID of the message to select.
 * @returns {Promise<Window>} The about:3pane window.
 */
async function selectMessage(uri, messageId) {
  const pane = about3Pane();
  // A new folder's pane row can appear after creation; retry until shown.
  await waitFor(
    () => {
      if (pane.gFolder?.URI != uri) {
        pane.displayFolder(uri);
        return false;
      }
      return pane.gDBView && pane.dbViewWrapperListener.allMessagesLoaded;
    },
    "The folder view loads " + uri,
    100,
    600
  );
  const folder = MailServices.folderLookup.getFolderForURL(uri);
  const header = [...folder.messages].find(h => h.messageId == messageId);
  if (!header) {
    throw new Error(`${messageId} is not in ${uri}`);
  }
  pane.threadTree.selectedIndex = pane.gDBView.findIndexOfMsgHdr(header, true);
  await waitFor(
    () => pane.gDBView.hdrForFirstSelectedMessage?.messageId == messageId,
    "The message is selected",
    100,
    600
  );
  return pane;
}

/**
 * Opens one message in the message pane and reads what is displayed.
 *
 * @param {string} uri - Folder URI.
 * @param {string} messageId - Message-ID.
 * @param {string} body - Body text that must be displayed.
 * @returns {Promise<object>} Displayed identity and text.
 */
async function display(uri, messageId, body) {
  const pane = await selectMessage(uri, messageId);
  const aboutMessage = pane.messageBrowser.contentWindow;
  await waitFor(
    () => {
      const text =
        aboutMessage.getMessagePaneBrowser?.()?.contentDocument?.body
          ?.textContent;
      return (
        aboutMessage.gMessage?.messageId == messageId && text?.includes(body)
      );
    },
    `The message pane displays ${messageId}`,
    100,
    600
  );
  const shown = aboutMessage.gMessage;
  return {
    folderURI: shown.folder.URI,
    messageId: shown.messageId,
    subject: shown.mime2DecodedSubject,
    author: shown.mime2DecodedAuthor,
    text: aboutMessage.getMessagePaneBrowser().contentDocument.body.textContent,
  };
}

/**
 * Runs one real thread-pane command on the selected message.
 *
 * @param {object} a - {uri, messageId, command, target}.
 */
async function command(a) {
  const pane =
    a.command == "cmd_undo"
      ? about3Pane()
      : await selectMessage(a.uri, a.messageId);
  if (a.command == "cmd_undo") {
    pane.document.getElementById("cmd_undo").doCommand();
    return;
  }
  const target = a.target
    ? MailServices.folderLookup.getFolderForURL(a.target)
    : undefined;
  await pane.commandController.doCommand(a.command, target);
}

/**
 * Indexes current data, opens the real facet tab for a term and opens the
 * conversation of one result through the facet context.
 *
 * @param {object} a - {term, conversationMessageId}.
 * @returns {Promise<object>} Physical result identities.
 */
async function search(a) {
  const { getMailSearchService } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MailSearch.sys.mjs"
  );
  const identity = h => ({
    folderURI: h.folder.URI,
    key: h.messageKey,
    messageId: h.messageId,
  });
  const service = await getMailSearchService();
  let progress;
  do {
    progress = await service.update({ limit: 500 });
  } while (progress.moreWork);
  const tabmail = win.document.getElementById("tabmail");
  const tab = tabmail.openTab("glodaFacet", { mailSearch: { text: a.term } });
  try {
    await waitFor(() => tab.searchPromise, "Facet query starts", 100, 600);
    await tab.searchPromise;
    const context = tab.browser.contentWindow.FacetContext;
    const byId = new Map(
      a.uris.map(uri => {
        const folder = MailServices.folderLookup.getFolderForURL(uri);
        return [folder.id, uri];
      })
    );
    const hits = context.fullSet.map(item => ({
      folderURI: byId.get(item.location.folderId) ?? null,
      key: item.location.messageKey,
      messageId: item.messageId,
    }));
    const facets = context.faceters.map(f => ({
      field: f.field ?? null,
      type: f.type ?? null,
      groups: (f.orderedGroups ?? []).length,
    }));
    const chosen = context.fullSet.find(
      item => item.messageId == a.conversationMessageId
    );
    if (!chosen) {
      throw new Error("The conversation message is not a search result");
    }
    const list = await context.openMailSearchConversation(chosen, true);
    if (!list) {
      throw new Error("The conversation list did not open");
    }
    await waitFor(
      () => {
        const view = list.chromeBrowser?.contentWindow;
        return (
          view?.gViewWrapper?.isSynthetic &&
          view.dbViewWrapperListener.allMessagesLoaded
        );
      },
      "The conversation list completes",
      100,
      600
    );
    const view = list.chromeBrowser.contentWindow;
    const conversation = Array.from({ length: view.gDBView.rowCount }, (_, i) =>
      identity(view.gDBView.getMsgHdrAt(i))
    );
    tabmail.closeTab(list);
    return { hits, facets, conversation };
  } finally {
    tabmail.closeTab(tab);
  }
}

/**
 * Reads the temporary extension's reported result from the console API store.
 *
 * @param {string} prefix - Fixed message prefix.
 * @returns {object|null} Parsed report, or null before it is written.
 */
function extensionReport(prefix) {
  const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
    Ci.nsIConsoleAPIStorage
  );
  for (const event of storage.getEvents()) {
    const first = event.arguments?.[0];
    if (typeof first == "string" && first.startsWith(prefix)) {
      return JSON.parse(first.slice(prefix.length));
    }
  }
  return null;
}

(async () => {
  switch (action) {
    case "fresh-setup": {
      startServer("fresh");
      const root = localRoot();
      const inbox = await createImapAccount(false);
      const a = root.createLocalSubfolder("S711FolderA");
      const b = root.createLocalSubfolder("S711FolderB");
      const trash = root.getFolderWithFlags(Ci.nsMsgFolderFlags.Trash);
      return {
        inbox: inbox.URI,
        a: a.URI,
        b: b.URI,
        trash: trash.URI,
        messages: IMAP_MESSAGES.fresh,
      };
    }
    case "legacy-setup": {
      startServer("migrated");
      const root = localRoot();
      const inbox = await createImapAccount(true);
      const local = root
        .createLocalSubfolder("S711Migrated")
        .QueryInterface(Ci.nsIMsgLocalMailFolder);
      for (const m of LOCAL_THREAD) {
        local.addMessage(
          "From - Sun Nov 08 12:00:00 2026\r\n" + messageText(m)
        );
      }
      local.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
      inbox.msgDatabase.commit(Ci.nsMsgDBCommitType.kLargeCommit);
      Services.prefs.savePrefFile(null);
      return {
        inbox: inbox.URI,
        local: local.URI,
        imapMessages: IMAP_MESSAGES.migrated,
        localMessages: LOCAL_THREAD,
      };
    }
    case "stop-server":
      stopServer();
      return true;
    case "snapshot":
      return snapshot(args.uris);
    case "display":
      return display(args.uri, args.messageId, args.body);
    case "command":
      await command(args);
      return true;
    case "search":
      return search(args);
    case "extension-report":
      return extensionReport(args.prefix);
    default:
      throw new Error("Unknown action " + action);
  }
})().then(done, error => done({ error: String(error), stack: error?.stack }));
