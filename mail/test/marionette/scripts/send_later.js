/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const [action, fixture, rejectDelivery] = arguments;
const done = arguments[arguments.length - 1];
const { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const owner = Services.wm.getMostRecentWindow("mail:3pane");

/**
 * Registers the existing installed test modules for this application process.
 *
 * @returns {nsIResProtocolHandler} The resource handler to restore in cleanup.
 */
function registerModules() {
  const handler = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  if (owner.s375Modules) {
    return handler;
  }
  let root = Services.dirsvc.get("GreD", Ci.nsIFile);
  for (let depth = 0; root && depth < 5; depth++, root = root.parent) {
    const modules = root.clone();
    modules.append("_tests");
    modules.append("modules");
    const hasModule = name => {
      const file = modules.clone();
      file.append("mailnews");
      file.append(name);
      return file.exists();
    };
    if (["Auth.sys.mjs", "Maild.sys.mjs", "Smtpd.sys.mjs"].every(hasModule)) {
      const previous = handler.hasSubstitution("testing-common")
        ? handler.getSubstitution("testing-common")
        : null;
      owner.s375Modules = { previous };
      handler.setSubstitution(
        "testing-common",
        Services.io.newFileURI(modules)
      );
      return handler;
    }
  }
  throw new Error(
    "The ordinary installed _tests/modules/mailnews payload is missing"
  );
}

/**
 * Reads physical headers and their real stored bytes in key order.
 *
 * @param {string} uri - The existing local folder URI.
 * @returns {{folderURI: string, key: number, messageId: string, subject: string,
 *   author: string, recipients: string, flags: number, raw: string}[]} Stored messages.
 */
function stored(uri) {
  const folder = MailServices.folderLookup.getFolderForURL(uri);
  return [...folder.messages]
    .map(header => {
      const input = folder.getMsgInputStream(header);
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
      return {
        folderURI: folder.URI,
        key: header.messageKey,
        messageId: header.messageId,
        subject: header.subject,
        author: header.author,
        recipients: header.recipients,
        flags: header.flags,
        raw,
      };
    })
    .sort((a, b) => a.key - b.key);
}

/**
 * Returns the active native backend, profile, body store and owned messages.
 *
 * @param {{outbox: string, sent: string, control: string}} data - Fixture folders.
 * @returns {object} Process identity and physical fixture contents.
 */
function snapshot(data) {
  const core = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  const outbox = MailServices.folderLookup.getFolderForURL(data.outbox);
  return {
    native: core instanceof Ci.nsIDatabaseCore,
    nativeCID: Cc["@mozilla.org/msgDatabase/msgDBService;1"].number,
    enabled: Services.prefs.getBoolPref("mail.panorama.enabled"),
    indexer: Services.prefs.getBoolPref(
      "mailnews.database.global.indexer.enabled"
    ),
    store: outbox.server.msgStore.storeType,
    pid: Services.appinfo.processID,
    profile: Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    queue: stored(data.outbox),
    sent: stored(data.sent),
    control: stored(data.control),
  };
}

/** Stops the current process's real SMTP server and restores resource mapping. */
async function stopServer() {
  if (owner.s375Smtp) {
    await owner.s375Smtp.server.stop();
    delete owner.s375Smtp;
  }
  if (owner.s375Modules) {
    const handler = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    handler.setSubstitution("testing-common", owner.s375Modules.previous);
    delete owner.s375Modules;
  }
}

(async () => {
  if (action == "setup") {
    const data = (owner.s375Fixture = {
      defaultAccount: MailServices.accounts.defaultAccount?.key,
    });
    let local = [...MailServices.accounts.allServers].find(
      server => server.type == "none"
    );
    if (!local) {
      MailServices.accounts.createLocalMailAccount();
      local = MailServices.accounts.localFoldersServer;
      data.localAccount = [...MailServices.accounts.accounts].find(
        account =>
          account.incomingServer == MailServices.accounts.localFoldersServer
      ).key;
    }
    const root =
      MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(
        Ci.nsIMsgLocalMailFolder
      );
    const account = MailServices.accounts.createAccount();
    data.account = account.key;
    account.incomingServer = MailServices.accounts.createIncomingServer(
      "s375",
      "localhost",
      "pop3"
    );
    account.incomingServer.setBoolValue("login_at_startup", false);
    account.incomingServer.setBoolValue("download_on_biff", false);
    const smtp = MailServices.outgoingServer
      .createServer("smtp")
      .QueryInterface(Ci.nsISmtpServer);
    data.smtp = smtp.key;
    smtp.hostname = "localhost";
    smtp.authMethod = Ci.nsMsgAuthMethod.none;
    smtp.socketType = Ci.nsMsgSocketType.plain;
    smtp.port = 1; // No server runs before the explicit post-restart delivery.
    const identity = MailServices.accounts.createIdentity();
    identity.email = "queued-s375@example.invalid";
    identity.smtpServerKey = smtp.key;
    identity.doFcc = true;
    account.addIdentity(identity);
    account.defaultIdentity = identity;
    MailServices.accounts.defaultAccount = account;
    data.identity = identity.key;
    data.sent = root.createLocalSubfolder("S375Sent").URI;
    data.control = root.createLocalSubfolder("S375Control").URI;
    identity.fccFolder = data.sent;
    MailServices.accounts.setSpecialFolders();
    const later = Cc["@mozilla.org/messengercompose/sendlater;1"].getService(
      Ci.nsIMsgSendLater
    );
    data.outbox = later.getUnsentMessagesFolder(identity).URI;
    if (stored(data.outbox).length) {
      throw new Error("The ordinary profile Outbox must be initially empty");
    }
    const text = n =>
      [
        "From: queued-s375@example.invalid",
        "To: queued-recipient@example.invalid",
        "Date: Wed, 01 Jan 2025 00:00:00 +0000",
        `Subject: S375 queued message ${n}`,
        `Message-ID: <s375-queue-${n}@example.invalid>`,
        `X-Mozilla-Identity-Key: ${identity.key}`,
        `X-Mozilla-Account-Key: ${account.key}`,
        `FCC: ${data.sent}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        `S375 exact queued body ${n}.`,
        "",
      ].join("\r\n");
    const control = MailServices.folderLookup
      .getFolderForURL(data.control)
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    control.addMessage(
      text(1).replace("S375 exact queued body 1.", "Outside equal-ID control.")
    );
    const completions = [];
    for (const n of [1, 2]) {
      const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
      file.append("s375-send-later.eml");
      file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      try {
        await IOUtils.writeUTF8(file.path, text(n));
        const fields = Cc[
          "@mozilla.org/messengercompose/composefields;1"
        ].createInstance(Ci.nsIMsgCompFields);
        fields.from = identity.email;
        fields.to = "queued-recipient@example.invalid";
        fields.fcc = data.sent;
        const send = Cc["@mozilla.org/messengercompose/send;1"].createInstance(
          Ci.nsIMsgSend
        );
        const completion = { count: 0, status: null };
        await new Promise((resolve, reject) => {
          const listener = {
            QueryInterface: ChromeUtils.generateQI([
              "nsIMsgCopyServiceListener",
              "nsIMsgSendListener",
            ]),
            onStartCopy() {},
            onProgress() {},
            setMessageKey() {},
            getMessageId() {
              return "";
            },
            onStopCopy(status) {
              completion.count++;
              completion.status = status;
              Components.isSuccessCode(status)
                ? resolve()
                : reject(Components.Exception("Queue failed", status));
            },
            onStartSending() {},
            onStatus() {},
            onStopSending() {},
            onGetDraftFolderURI() {},
            onSendNotPerformed() {},
            onTransportSecurityError() {},
          };
          send.sendMessageFile(
            identity,
            account.key,
            fields,
            file,
            false,
            false,
            Ci.nsIMsgSend.nsMsgQueueForLater,
            null,
            listener,
            null
          );
        });
        completions.push(completion);
      } finally {
        if (file.exists()) {
          file.remove(false);
        }
      }
    }
    MailServices.accounts.saveAccountInfo();
    Services.prefs.savePrefFile(null);
    return { fixture: data, completions, snapshot: snapshot(data) };
  }
  if (action == "snapshot") {
    return snapshot(fixture);
  }
  if (action == "stop") {
    await stopServer();
    return null;
  }
  if (action == "send") {
    registerModules();
    const { nsMailServer } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/Maild.sys.mjs"
    );
    const { SmtpDaemon, SMTP_RFC2821_handler } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/Smtpd.sys.mjs"
    );
    const daemon = new SmtpDaemon();
    daemon.received = [];
    daemon.rejectDelivery = rejectDelivery;
    class QueueHandler extends SMTP_RFC2821_handler {
      RCPT(args) {
        return this._daemon.rejectDelivery
          ? "550 S375 recipient rejected"
          : super.RCPT(args);
      }
      onMultiline(line) {
        const delivered = line == "." && this.expectingData;
        const result = super.onMultiline(line);
        if (delivered) {
          this._daemon.received.push(this._daemon.post);
        }
        return result;
      }
    }
    const server = new nsMailServer(d => new QueueHandler(d), daemon);
    owner.s375Smtp = { server, daemon };
    server.start();
    const smtp = MailServices.outgoingServer
      .getServerByKey(fixture.smtp)
      .QueryInterface(Ci.nsISmtpServer);
    smtp.port = server.port;
    const later = Cc["@mozilla.org/messengercompose/sendlater;1"].getService(
      Ci.nsIMsgSendLater
    );
    const identity = MailServices.accounts.getIdentity(fixture.identity);
    const events = { starts: [], messageStarts: [], errors: [], stops: [] };
    const previousPrompt = Services.prompt;
    const alerts = [];
    Services.prompt = {
      QueryInterface: ChromeUtils.generateQI(["nsIPromptService"]),
      alert(parent, title, text) {
        alerts.push(text);
      },
    };
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgSendLaterListener"]),
      onStartSending(total) {
        events.starts.push(total);
      },
      onMessageStartSending(current, total, header, usedIdentity) {
        events.messageStarts.push({
          current,
          total,
          folderURI: header.folder.URI,
          key: header.messageKey,
          messageId: header.messageId,
          identity: usedIdentity.key,
        });
      },
      onMessageSendProgress() {},
      onMessageSendError(current, header, status) {
        events.errors.push({
          current,
          key: header.messageKey,
          messageId: header.messageId,
          status,
        });
      },
      onStopSending(status, message, tried, successful) {
        events.stops.push({ status, tried, successful });
        Services.tm.dispatchToMainThread(() => resolveStop());
      },
    };
    let resolveStop;
    try {
      await new Promise((resolve, reject) => {
        resolveStop = resolve;
        later.addListener(listener);
        try {
          later.sendUnsentMessages(identity);
        } catch (error) {
          reject(error);
        }
      });
      return {
        ...events,
        alerts,
        received: daemon.received,
        sending: later.sendingMessages,
        expectedError: Cr.NS_ERROR_FAILURE,
        snapshot: snapshot(fixture),
      };
    } finally {
      later.removeListener(listener);
      Services.prompt = previousPrompt;
      await stopServer();
    }
  }
  if (action == "cleanup") {
    await stopServer();
    const data = fixture || owner.s375Fixture;
    if (!data) {
      return null;
    }
    if (data.outbox) {
      const outbox = MailServices.folderLookup.getFolderForURL(data.outbox);
      const messages = [...outbox.messages].filter(header =>
        [
          "s375-queue-1@example.invalid",
          "s375-queue-2@example.invalid",
        ].includes(header.messageId)
      );
      if (messages.length) {
        await new Promise((resolve, reject) =>
          outbox.deleteMessages(
            messages,
            null,
            true,
            false,
            {
              onStopCopy(status) {
                Components.isSuccessCode(status)
                  ? resolve()
                  : reject(Components.Exception("Cleanup failed", status));
              },
            },
            false
          )
        );
      }
    }
    for (const uri of [data.sent, data.control].filter(Boolean)) {
      const folder = MailServices.folderLookup.getFolderForURL(uri);
      folder.parent.propagateDelete(folder, true);
    }
    if (data.account) {
      MailServices.accounts.removeAccount(
        MailServices.accounts.getAccount(data.account),
        true
      );
    }
    if (data.smtp) {
      MailServices.outgoingServer.deleteServer(
        MailServices.outgoingServer.getServerByKey(data.smtp)
      );
    }
    if (data.defaultAccount) {
      MailServices.accounts.defaultAccount = MailServices.accounts.getAccount(
        data.defaultAccount
      );
    }
    if (data.localAccount) {
      MailServices.accounts.removeAccount(
        MailServices.accounts.getAccount(data.localAccount),
        true
      );
    }
    delete owner.s375Fixture;
    return null;
  }
  throw new Error(`Unknown send-later test action: ${action}`);
})().then(
  value => done({ value }),
  error => done({ error: String(error), stack: error.stack })
);
