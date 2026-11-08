/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { mailTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MailTestUtils.sys.mjs"
);
var { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);
var { nsMailServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/Maild.sys.mjs"
);
var { PromiseTestUtils: MailPromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);
var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

// Persistent Listener test functionality
var { assertPersistentListeners } = ExtensionTestUtils.testAssertions;

ExtensionTestUtils.init(this);

var IS_IMAP = false;
var IS_NNTP = false;
var IS_EWS = false;

function formatVCard(strings, ...values) {
  const arr = [];
  for (const str of strings) {
    arr.push(str);
    arr.push(values.shift());
  }
  const lines = arr.join("").split("\n");
  const indent = lines[1].length - lines[1].trimLeft().length;
  const outLines = [];
  for (const line of lines) {
    if (line.length > 0) {
      outLines.push(line.substring(indent) + "\r\n");
    }
  }
  return outLines.join("");
}

/**
 * Creates an account and awaits protocol setup before returning it.
 *
 * @param {string} [type="none"] - Incoming server type.
 * @param {{extensions?: string[]}} [options={}] - Fake IMAP extensions.
 * @returns {Promise<nsIMsgAccount>} The account after successful setup.
 */
async function createAccount(type = "none", options = {}) {
  if (type == "local") {
    const localAccount = MailServices.accounts.createLocalMailAccount();
    info(`Created LOCAL account ${localAccount.toString()}`);
    return localAccount;
  }

  const account = MailServices.accounts.createAccount();
  const native = Services.prefs.getBoolPref("mail.panorama.enabled", false);
  account.incomingServer = MailServices.accounts.createIncomingServer(
    native && ["imap", "ews"].includes(type) ? "user" : `${account.key}user`,
    "localhost",
    type
  );

  if (["pop3", "none"].includes(type)) {
    info(`Created account ${account.toString()}`);
    return account;
  }

  if (type == "imap") {
    const imapServer = new IMAPServer({
      ...options,
      username: account.incomingServer.username,
    });
    imapServer.open();
    account.incomingServer.port = imapServer.port;
    account.incomingServer.password = "password";
    const listener = new MailPromiseTestUtils.PromiseUrlListener();
    MailServices.imap.discoverAllFolders(
      account.incomingServer.rootFolder,
      listener,
      null
    );
    await listener.promise;
    const inbox = account.incomingServer.rootFolder.getChildNamed("INBOX");
    if (!inbox) {
      throw new Error("IMAP discovery completed without an Inbox");
    }
    inbox.QueryInterface(Ci.nsIMsgImapMailFolder).hierarchyDelimiter = "/";
    gIMAPServers.set(account.incomingServer.key, imapServer);
    info(`Created IMAP account ${account.toString()}`);
    return account;
  }

  if (type == "nntp") {
    NNTPServer.open();
    account.incomingServer.port = NNTPServer.port;
    info(`Created NNTP account ${account.toString()}`);
    return account;
  }

  if (type == "ews") {
    const ewsServer = new EWSServer();
    ewsServer.open();
    account.incomingServer.port = ewsServer.port;
    if (!native) {
      // Legacy account events retain the original create-then-rename sequence.
      account.incomingServer.username = "user";
    }
    account.incomingServer.password = "password";
    account.incomingServer.setStringValue(
      "ews_url",
      `http://127.0.0.1:${ewsServer.port}/EWS/Exchange.asmx`
    );
    account.incomingServer.getNewMessages(
      account.incomingServer.rootFolder,
      null,
      null
    );

    // Wait for the folders list to finish being synchronised.
    // TODO: This code is copied from [1], think about using a shared module.
    // [1] https://searchfox.org/comm-central/source/mailnews/protocols/exchange/test/unit/test_folder_sync.js#54-63
    await TestUtils.waitForCondition(() => {
      // Folders are created in the order we give them to the EWS server in.
      // Therefore if the last one in the array has been created, we can safely
      // assume all of the folders have been correctly synchronised.
      const lastFolder = ewsServer.server.folders.at(-1);
      return !!account.incomingServer.rootFolder.getChildNamed(
        lastFolder.displayName
      );
    }, "waiting for subfolders to populate");

    info(`Created EWS account ${account.toString()}`);
    return account;
  }

  throw new Error(`Unsupported account type: ${type}`);
}

function cleanUpAccount(account) {
  const serverKey = account.incomingServer.key;
  const serverType = account.incomingServer.type;
  info(
    `Cleaning up ${serverType} account ${account.key} and server ${serverKey}`
  );

  if (account.incomingServer.type == "ews") {
    account.incomingServer.closeCachedConnections();
  }

  MailServices.accounts.removeAccount(account, true);

  try {
    const server = MailServices.accounts.getIncomingServer(serverKey);
    if (server) {
      info(`Cleaning up leftover ${serverType} server ${serverKey}`);
      MailServices.accounts.removeIncomingServer(server, false);
    }
    // eslint-disable-next-line no-unused-vars
  } catch (e) {}
}

registerCleanupFunction(() => {
  MailServices.accounts.accounts.forEach(cleanUpAccount);
  Services.prefs.setStringPref("extensions.webextensions.uuids", "{}");
});

function addIdentity(account, email = "xpcshell@localhost") {
  const identity = MailServices.accounts.createIdentity();
  identity.email = email;
  account.addIdentity(identity);
  if (!account.defaultIdentity) {
    account.defaultIdentity = identity;
  }
  info(`Created identity ${identity.toString()}`);
  return identity;
}

async function createSubfolder(parent, name) {
  if (parent.server.type == "nntp") {
    createNewsgroup(name);
    const account = MailServices.accounts.findAccountForServer(parent.server);
    subscribeNewsgroup(account, name);
    return parent.getChildNamed(name);
  }

  const promiseAdded = MailPromiseTestUtils.promiseFolderAdded(name);
  parent.createSubfolder(name, null);
  await promiseAdded;
  const folder = parent.getChildNamed(name);
  if (parent.server.type == "imap") {
    // Admit the actual server UIDVALIDITY before an operation captures this
    // cold destination's database. The first SELECT may replace a legacy DB.
    const listener = new MailPromiseTestUtils.PromiseUrlListener();
    folder
      .QueryInterface(Ci.nsIMsgImapMailFolder)
      .updateFolderWithListener(null, listener);
    await listener.promise;
  }
  return folder;
}

async function createMessages(folder, makeMessagesArg) {
  if (typeof makeMessagesArg == "number") {
    makeMessagesArg = { count: makeMessagesArg };
  }
  if (!createMessages.messageGenerator) {
    createMessages.messageGenerator = new MessageGenerator();
  }

  const messages =
    createMessages.messageGenerator.makeMessages(makeMessagesArg);
  await addGeneratedMessages(folder, messages);
}

class FakeGeneratedMessage {
  constructor(msg) {
    this.msg = msg;
  }
  toMessageString() {
    return this.msg;
  }
}

async function createMessageFromFile(folder, path) {
  const message = await IOUtils.readUTF8(path);
  await addGeneratedMessages(folder, [new FakeGeneratedMessage(message)]);
}

async function createMessageFromString(folder, message) {
  await addGeneratedMessages(folder, [new FakeGeneratedMessage(message)]);
}

async function addGeneratedMessages(folder, messages) {
  if (folder.server.type == "imap" && gIMAPServers.has(folder.server.key)) {
    return gIMAPServers.get(folder.server.key).addMessages(folder, messages);
  }
  if (folder.server.type == "nntp") {
    return NNTPServer.addMessages(folder, messages);
  }

  const messageStrings = messages.map(message => message.toMessageString());
  folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
  folder.addMessageBatch(messageStrings);
  folder.callFilterPlugins(null);

  return new Promise(resolve =>
    mailTestUtils.updateFolderAndNotify(folder, resolve)
  );
}

async function getUtilsJS() {
  return IOUtils.readUTF8(do_get_file("data/utils.js").path);
}

var gIMAPServers = new Map();
/** Runs a fake IMAP server with selected protocol extensions. */
class IMAPServer {
  /**
   * @param {{extensions?: string[], username?: string}} [options={}] -
   *   Protocol extensions and login name. The default login name is "user".
   */
  constructor(options = {}) {
    this.extensions = options?.extensions ?? [];
    this.username = options?.username ?? "user";
  }

  open() {
    const ImapD = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/Imapd.sys.mjs"
    );
    const { IMAP_RFC3501_handler, ImapDaemon, ImapMessage, mixinExtension } =
      ImapD;

    this.ImapMessage = ImapMessage;
    this.daemon = new ImapDaemon();
    this.server = new nsMailServer(daemon => {
      const handler = new IMAP_RFC3501_handler(daemon, {
        username: this.username,
      });
      for (const ext of this.extensions) {
        mixinExtension(handler, ImapD[`IMAP_${ext}_extension`]);
      }
      return handler;
    }, this.daemon);

    this.server.start();

    registerCleanupFunction(() => this.close());
  }
  close() {
    return this.server.stop();
  }
  get port() {
    return this.server.port;
  }

  addMessages(folder, messages) {
    folder.QueryInterface(Ci.nsIMsgImapMailFolder);
    const fakeFolder = this.daemon.getMailbox(folder.name);
    messages.forEach(message => {
      if (typeof message != "string") {
        message = message.toMessageString();
      }
      const msgURI = Services.io.newURI(
        "data:text/plain;base64," + btoa(message)
      );
      const imapMsg = new this.ImapMessage(
        msgURI.spec,
        fakeFolder.uidnext++,
        []
      );
      fakeFolder.addMessage(imapMsg);
    });

    const listener = new MailPromiseTestUtils.PromiseUrlListener();
    folder.updateFolderWithListener(null, listener);
    return listener.promise;
  }
}

function subscribeNewsgroup(account, group) {
  account.incomingServer.QueryInterface(Ci.nsINntpIncomingServer);
  account.incomingServer.subscribeToNewsgroup(group);
  account.incomingServer.maximumConnectionsNumber = 1;
}

function createNewsgroup(group) {
  if (!NNTPServer.hasGroup(group)) {
    NNTPServer.addGroup(group);
  }
}

var NNTPServer = {
  open() {
    const { NNTP_RFC977_handler, NntpDaemon } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/Nntpd.sys.mjs"
    );

    this.daemon = new NntpDaemon();
    this.server = new nsMailServer(
      daemon => new NNTP_RFC977_handler(daemon),
      this.daemon
    );
    this.server.start();

    registerCleanupFunction(() => this.close());
  },

  close() {
    return this.server.stop();
  },
  get port() {
    return this.server.port;
  },

  addGroup(group) {
    return this.daemon.addGroup(group);
  },

  hasGroup(group) {
    return this.daemon.getGroup(group) != null;
  },

  addMessages(folder, messages) {
    const { NewsArticle } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/Nntpd.sys.mjs"
    );

    const group = folder.name;
    messages.forEach(message => {
      if (typeof message != "string") {
        message = message.toMessageString();
      }
      // The NNTP daemon needs a trailing empty line.
      if (!message.endsWith("\r\n")) {
        message = message + "\r\n";
      }
      const article = new NewsArticle(message);
      article.groups = [group];
      this.daemon.addArticle(article);
    });

    return new Promise(resolve => {
      mailTestUtils.updateFolderAndNotify(folder, resolve);
    });
  },
};

class EWSServer {
  constructor() {}

  open() {
    const { EwsServer } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/EwsServer.sys.mjs"
    );
    this.server = new EwsServer();
    this.server.start();
    registerCleanupFunction(() => this.close());
  }

  close() {
    return this.server.stop();
  }

  get port() {
    return this.server.port;
  }

  addMessages(_folder, _messages) {
    // TODO.
  }
}
