/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MsgIncomingServer } from "resource:///modules/MsgIncomingServer.sys.mjs";
import { MailServices } from "resource:///modules/MailServices.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Pop3Client: "resource:///modules/Pop3Client.sys.mjs",
});

// These are the actual constructed clients/servers, not account enumeration.
const migrationClients = new Set();
const migrationServers = new Set();
let migrationView = null;
let migrationDrain = null;
let migrationRelease = null;
let migrationCapturedClients = [];
let migrationCapturedServers = [];
let migrationReleased = false;

/**
 * Returns the fixed native gate in Panorama builds.
 *
 * @returns {?nsIObserver} The process-owned gate, or null in other builds.
 */
function popMigrationGate() {
  if (!("nsIDatabaseCore" in Ci)) {
    return null;
  }
  return Cc["@mozilla.org/mailnews/migration-writer-lease;1"].getService(
    Ci.nsIObserver
  );
}

/** Checks fresh POP admission before constructing or queuing work. */
export function checkPop3MigrationAdmission() {
  const gate = popMigrationGate();
  if (gate) {
    const subject = gate
      .QueryInterface(Ci.nsIPropertyBag2)
      .getPropertyAsInterface("writer-admission-subject", Ci.nsISupports);
    gate.observe(subject, "check-writer-admission", "pop3");
  }
}

/**
 * Validates ownership of already-captured work without granting fresh IO.
 *
 * @param {nsISupports} nativeView - The original native selected view.
 */
export function validatePop3MigrationView(nativeView) {
  const gate = popMigrationGate();
  if (!gate || !nativeView) {
    throw Components.Exception(
      "Missing selected POP owner",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  gate.observe(nativeView, "validate-selected-view", "after-await");
}

/** @param {Pop3Client} client - An actual newly constructed client. */
export function trackPop3MigrationClient(client) {
  migrationClients.add(client);
}

/** @param {Pop3Client} client - A client whose actual terminal has returned. */
export function forgetPop3MigrationClient(client) {
  if (client.migrationTerminalSettled) {
    migrationClients.delete(client);
  }
}

/**
 * Captures actual POP work synchronously and joins its real shared terminals.
 * Native Core and the LS body participant join this same Promise.
 *
 * @param {nsISupports} nativeView - The exact native selected owner.
 * @returns {Promise<void>} Resolves after all captured IO/callbacks settle.
 */
export function drainPop3MigrationWriters(nativeView) {
  validatePop3MigrationView(nativeView);
  if (migrationView && migrationReleased && nativeView != migrationView) {
    // The native gate validated this new selected generation. The old release
    // stays shared for its own view until a real new owner is admitted here.
    migrationView = null;
    migrationDrain = null;
    migrationRelease = null;
    migrationCapturedClients = [];
    migrationCapturedServers = [];
    migrationReleased = false;
  }
  if (migrationView) {
    if (nativeView != migrationView) {
      throw Components.Exception(
        "Foreign POP owner",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    return migrationDrain;
  }
  migrationView = nativeView;
  const clients = [...migrationClients];
  migrationCapturedClients = clients;
  const terminals = clients.map(client =>
    client.beginMigrationDrain(nativeView)
  );
  // Queued runs have no client/IO to finish. Settle their real waiting Promise;
  // never let an onFree callback construct them after the native fence.
  Pop3IncomingServer.rejectMigrationQueue();
  for (const reference of migrationServers) {
    const server = reference.deref();
    if (!server) {
      migrationServers.delete(reference);
      continue;
    }
    migrationCapturedServers.push(server);
    terminals.push(server.beginMigrationDrain(nativeView));
  }
  migrationDrain = Promise.allSettled(terminals).then(results => {
    validatePop3MigrationView(nativeView);
    const errors = results
      .filter(result => result.status == "rejected")
      .map(result => result.reason);
    if (errors.length) {
      const first = errors[0];
      const error = Components.Exception(
        "POP writer settlement failed",
        first?.result || Cr.NS_ERROR_FAILURE
      );
      error.secondaryErrors = errors.slice(1);
      throw error;
    }
  });
  return migrationDrain;
}

/**
 * Releases only captured, actually settled POP ownership after the consumer.
 *
 * @param {nsISupports} nativeView - The same native selected owner.
 * @param {nsresult} settlementNsresult - The actual consumer result.
 * @returns {Promise<void>} The shared once-only release terminal.
 */
export function releasePop3MigrationWriters(nativeView, settlementNsresult) {
  validatePop3MigrationView(nativeView);
  if (nativeView != migrationView || !migrationDrain) {
    throw Components.Exception(
      "Unacquired POP owner",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  if (!migrationRelease) {
    migrationRelease = migrationDrain
      .catch(() => {})
      .then(() => {
        validatePop3MigrationView(nativeView);
        for (const client of migrationCapturedClients) {
          client.releaseMigrationDrain(nativeView);
        }
        for (const server of migrationCapturedServers) {
          server.releaseMigrationDrain(nativeView, settlementNsresult);
        }
        // Keep the same release Promise for repeated calls from this owner.
        // Only the native parent can admit a subsequent selected generation.
        migrationReleased = Components.isSuccessCode(settlementNsresult);
      });
  }
  return migrationRelease;
}

/**
 * @implements {nsIPop3IncomingServer}
 * @implements {nsILocalMailIncomingServer}
 * @implements {nsIMsgIncomingServer}
 * @implements {nsISupportsWeakReference}
 */
export class Pop3IncomingServer extends MsgIncomingServer {
  QueryInterface = ChromeUtils.generateQI([
    "nsIPop3IncomingServer",
    "nsILocalMailIncomingServer",
    "nsIMsgIncomingServer",
    "nsISupportsWeakReference",
  ]);

  // @type {Boolean} - A flag to indicate that a client run is in progress.
  static #_busyConnections = false;
  // @type {Function[]} - An array of Promise.resolve functions used as a queue.
  static #_connectionWaitingQueue = [];

  constructor() {
    checkPop3MigrationAdmission();
    super();

    // nsIMsgIncomingServer attributes.
    this.localStoreType = "mailbox";
    this.localDatabaseType = "mailbox";
    this.canBeDefaultServer = true;

    Object.defineProperty(this, "canCreateFoldersOnServer", {
      get: () => !this.deferredToAccount,
    });
    Object.defineProperty(this, "canFileMessagesOnServer", {
      get: () => !this.deferredToAccount,
    });

    // nsIPop3IncomingServer attributes that map directly to pref values.
    this._mapAttrsToPrefs([
      ["Bool", "leaveMessagesOnServer", "leave_on_server"],
      ["Bool", "headersOnly", "headers_only"],
      ["Bool", "deleteMailLeftOnServer", "delete_mail_left_on_server"],
      ["Bool", "deleteByAgeFromServer", "delete_by_age_from_server"],
      ["Bool", "deferGetNewMail", "defer_get_new_mail"],
      ["Int", "numDaysToLeaveOnServer", "num_days_to_leave_on_server"],
    ]);

    // @type {Map<string,string>} - A map from uidl to status.
    this._uidlsToMark = new Map();
    this._migrationMarks = new Set();
    this._migrationRuns = new Set();
    migrationServers.add(new WeakRef(this));
  }

  /** @see nsIMsgIncomingServer */
  get rootMsgFolder() {
    if (this._rootMsgFolder) {
      return this._rootMsgFolder;
    }

    if (!this.deferredToAccount) {
      this._rootMsgFolder = this.rootFolder;
      return this._rootMsgFolder;
    }

    const incomingServer = MailServices.accounts.getAccount(
      this.deferredToAccount
    ).incomingServer;
    if (incomingServer.equals(this)) {
      // Make sure we're not deferred to ourself.
      throw Components.Exception(
        `${incomingServer.prettyName} cannot be deferred to itself`,
        Cr.NS_ERROR_FAILURE
      );
    }

    this._rootMsgFolder = incomingServer.rootMsgFolder;
    return this._rootMsgFolder;
  }

  get canSearchMessages() {
    return this.canFileMessagesOnServer;
  }

  getNewMessages(folder, msgWindow, urlListener) {
    const inbox = this.rootMsgFolder.getFolderWithFlags(
      Ci.nsMsgFolderFlags.Inbox
    );
    if (!this.deferredToAccount) {
      const deferredServers = this._getDeferedServers(folder.server);
      if (deferredServers.length) {
        // If other servers are deferred to this server, get new mail for them
        // as well.
        this.downloadMailFromServers(
          [...deferredServers, this],
          msgWindow,
          inbox,
          urlListener
        );
        return;
      }
    }
    // Occurs on get new mail for a single server.
    MailServices.pop3.GetNewMail(msgWindow, urlListener, inbox, this);
  }

  verifyLogon(urlListener, msgWindow) {
    return MailServices.pop3.verifyLogon(this, urlListener, msgWindow);
  }

  performBiff(msgWindow) {
    this.performingBiff = true;
    const inbox = this.rootMsgFolder.getFolderWithFlags(
      Ci.nsMsgFolderFlags.Inbox
    );
    const urlListener = inbox.QueryInterface(Ci.nsIUrlListener);
    try {
      // Occurs on biff for an individual server.
      if (this.downloadOnBiff) {
        MailServices.pop3.GetNewMail(msgWindow, urlListener, inbox, this);
      } else {
        MailServices.pop3.CheckForNewMail(msgWindow, urlListener, inbox, this);
      }
    } catch (error) {
      this.performingBiff = false;
      throw error;
    }
  }

  /** @see nsILocalMailIncomingServer */
  createDefaultMailboxes() {
    for (const name of ["Inbox", "Trash"]) {
      const folderUri = this.rootFolder.URI + "/" + name;
      if (!this.rootFolder.getChildWithURI(folderUri, false, false)) {
        this.msgStore.createFolder(this.rootFolder, name);
      }
    }
  }

  setFlagsOnDefaultMailboxes() {
    this.rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      // POP3 account gets an inbox, but no queue (unsent messages).
      .setFlagsOnDefaultMailboxes(
        Ci.nsMsgFolderFlags.SpecialUse & ~Ci.nsMsgFolderFlags.Queue
      );
  }

  // This is called when "Get Selected Messages" menu item is used to
  // to fetch full messages that previously had only the headers downloaded.
  getNewMail(msgWindow, urlListener, inbox) {
    MailServices.pop3.GetNewMail(msgWindow, urlListener, inbox, this);
  }

  /** @see nsIPop3IncomingServer */
  get deferredToAccount() {
    let accountKey = this.getStringValue("deferred_to_account");
    if (!accountKey) {
      return "";
    }

    const account = MailServices.accounts.getAccount(accountKey);
    // If currently deferred to an invalid or hidden server, change to defer to
    // the local folders inbox.
    if (!account || !account.incomingServer || account.incomingServer.hidden) {
      let localAccount;
      try {
        localAccount = MailServices.accounts.findAccountForServer(
          MailServices.accounts.localFoldersServer
        );
      } catch (e) {
        // MailServices.accounts.localFoldersServer throws if no Local Folders.
        return "";
      }
      accountKey = localAccount.key;
      this.setStringValue("deferred_to_account", accountKey);
    }

    return accountKey;
  }

  set deferredToAccount(accountKey) {
    this._rootMsgFolder = null;

    const wasDeferred = Boolean(this.deferredToAccount);
    this.setStringValue("deferred_to_account", accountKey);

    // If isDeferred state has changed, send notification.
    if (Boolean(accountKey) != wasDeferred) {
      const folderListenerManager = MailServices.mailSession.QueryInterface(
        Ci.nsIFolderListener
      );
      folderListenerManager.onFolderBoolPropertyChanged(
        this.rootFolder,
        "isDeferred",
        wasDeferred,
        !wasDeferred
      );
      folderListenerManager.onFolderBoolPropertyChanged(
        this.rootFolder,
        "CanFileMessages",
        !wasDeferred,
        wasDeferred
      );
    }

    if (!accountKey) {
      return;
    }
    // Check if we are deferred to the local folders, and create INBOX if needed.
    const server = MailServices.accounts.getAccount(accountKey).incomingServer;
    if (server instanceof Ci.nsILocalMailIncomingServer) {
      if (
        !server.rootFolder.getChildWithURI(
          `${server.rootFolder.URI}/Inbox`,
          false,
          false
        )
      ) {
        server.rootFolder.createSubfolder("Inbox", null);
      }
    }
  }

  addUidlToMark(uidl, mark) {
    // @see nsIMsgLocalMailFolder
    const POP3_DELETE = 1;
    const POP3_FETCH_BODY = 2;
    let status = "k";
    if (mark == POP3_DELETE) {
      status = "d";
    } else if (mark == POP3_FETCH_BODY) {
      status = "f";
    }
    this._uidlsToMark.set(uidl, status);
  }

  markMessages() {
    checkPop3MigrationAdmission();
    if (!this._uidlsToMark.size) {
      return;
    }

    const client = this.runningClient || new lazy.Pop3Client(this);
    // Pass a clone of this._uidlsToMark to client.markMessages, because
    // this._uidlsToMark may be changed before markMessages finishes.
    const pending = client.markMessages(new Map(this._uidlsToMark));
    this._migrationMarks.add(pending);
    // Keep the actual rejection for a later selected drain. Logging does not
    // turn a failed UIDL write into a successful/empty queue.
    pending.then(
      () => this._migrationMarks.delete(pending),
      error => {
        this._migrationMarkErrors ??= [];
        this._migrationMarkErrors.push(error);
        this._migrationMarks.delete(pending);
      }
    );
    this._uidlsToMark = new Map();
  }

  downloadMailFromServers(servers, msgWindow, folder, urlListener) {
    this._downloadMailFromServers(
      servers,
      msgWindow,
      folder,
      urlListener,
      Cr.NS_OK
    );
  }

  /**
   * Download from the remaining accounts, retaining the first failure.
   *
   * @param {nsIPop3IncomingServer[]} servers - Remaining accounts, consumed in order.
   * @param {?nsIMsgWindow} msgWindow - Window for download progress and prompts.
   * @param {nsIMsgFolder} folder - Shared destination folder.
   * @param {?nsIUrlListener} urlListener - Receives the final aggregate status.
   * @param {nsresult} status - Status of the accounts already processed.
   */
  _downloadMailFromServers(servers, msgWindow, folder, urlListener, status) {
    const server = servers.shift();
    if (!server) {
      urlListener?.OnStopRunningUrl(null, status);
      return;
    }

    // If server != folder.server, it means server is deferred to folder.server,
    // so if server.deferGetNewMail is false, no need to call GetNewMail.
    if (server == folder.server || server.deferGetNewMail) {
      // This recursive loop occurs on check new mail at startup and when
      // getting new mail for all servers.
      try {
        MailServices.pop3.GetNewMail(
          msgWindow,
          {
            OnStartRunningUrl() {},
            OnStopRunningUrl: (url, result) => {
              // Continue other accounts without losing the first failure.
              this._downloadMailFromServers(
                servers,
                msgWindow,
                folder,
                urlListener,
                Components.isSuccessCode(status) ? result : status
              );
            },
          },
          folder,
          server
        );
      } catch (error) {
        this._downloadMailFromServers(
          servers,
          msgWindow,
          folder,
          urlListener,
          Components.isSuccessCode(status)
            ? error.result || Cr.NS_ERROR_FAILURE
            : status
        );
      }
      return;
    }
    this._downloadMailFromServers(
      servers,
      msgWindow,
      folder,
      urlListener,
      status
    );
  }

  /**
   * Get all the servers that defer to the passed in server.
   *
   * @param {nsIMsgIncomingServer} dstServer - The server that others servers
   *   are deferred to.
   */
  _getDeferedServers(dstServer) {
    const dstAccount = MailServices.accounts.findAccountForServer(dstServer);
    if (!dstAccount) {
      return [];
    }
    return MailServices.accounts.allServers.filter(
      server =>
        server instanceof Ci.nsIPop3IncomingServer &&
        server.deferredToAccount == dstAccount.key
    );
  }

  /**
   * Construct and return a new client. If a client is not now running, this
   * will immediately return a new client. Otherwise it waits for the running
   * client to finish.
   *
   * @returns {Pop3Client}
   */
  async _getNewClient() {
    checkPop3MigrationAdmission();
    if (Pop3IncomingServer.#_busyConnections) {
      // Wait until the running client is done
      await new Promise((resolve, reject) =>
        Pop3IncomingServer.#_connectionWaitingQueue.push({ resolve, reject })
      );
    }
    checkPop3MigrationAdmission();
    Pop3IncomingServer.#_busyConnections = true;
    return new lazy.Pop3Client(this);
  }

  /**
   * Used to initiate a Pop3 service run and setup the specialized
   * handler functions needed for the service. This will construct a new
   * Pop3 client instance, define the needed handler sequence and functions,
   * connect to the server via network and trigger the client to do a sequence
   * of steps to complete the service run and then disconnect from the server.
   * This also ensures that only one service run occurs at a time when there are
   * more than one Pop3 account.
   *
   * @param {Function} handler - A callback function with Pop3Client instance
   *   as a parameter. Provides initialization needed before connection to
   *   the server and any handler functions needed by the client to perform
   *   the service.
   */
  withClient(handler) {
    checkPop3MigrationAdmission();
    const pending = this._withMigrationClient(handler);
    this._migrationRuns.add(pending);
    pending.then(
      () => this._migrationRuns.delete(pending),
      error => {
        this._migrationRunErrors ??= [];
        this._migrationRunErrors.push(error);
        this._migrationRuns.delete(pending);
      }
    );
    return pending;
  }

  /**
   * Joins actual client construction and setup after the synchronous gate.
   *
   * @param {function(Pop3Client): void} handler - The original setup callback.
   * @returns {Promise<void>} Resolves after setup; client IO has its own terminal.
   */
  async _withMigrationClient(handler) {
    const client = await this._getNewClient();
    // This handler function is needed for all client service runs.
    client.onFree = () => {
      Pop3IncomingServer.#_busyConnections = false;
      // Resolve the promised wait for the previous client run.
      Pop3IncomingServer.#_connectionWaitingQueue.shift()?.resolve();
    };
    try {
      checkPop3MigrationAdmission();
      // Specialized client handler sequence provided by the caller.
      handler(client);
      // Connect to pop3 server and perform the service run.
      client.connect();
    } catch (error) {
      client.abandonMigrationSetup(error);
      throw error;
    }
  }

  /** Settles queued, not-yet-constructed runs at the native admission fence. */
  static rejectMigrationQueue() {
    const queued = this.#_connectionWaitingQueue.splice(0);
    for (const entry of queued) {
      entry.reject(
        Components.Exception("POP admission closed", Cr.NS_ERROR_NOT_AVAILABLE)
      );
    }
  }

  /**
   * Joins actual independent markMessages calls made by this server.
   *
   * @param {nsISupports} nativeView - The exact native selected owner.
   * @returns {Promise<void>} Actual UIDL terminals, including previous errors.
   */
  beginMigrationDrain(nativeView) {
    validatePop3MigrationView(nativeView);
    if (this._migrationView) {
      if (this._migrationView != nativeView) {
        throw Components.Exception(
          "Foreign server owner",
          Cr.NS_ERROR_NOT_AVAILABLE
        );
      }
      return this._migrationDrain;
    }
    this._migrationView = nativeView;
    this._migrationDrain = Promise.allSettled([
      ...this._migrationMarks,
      ...this._migrationRuns,
    ]).then(results => {
      validatePop3MigrationView(nativeView);
      const errors = [
        ...new Set([
          ...(this._migrationMarkErrors || []),
          ...(this._migrationRunErrors || []),
          ...results
            .filter(result => result.status == "rejected")
            .map(result => result.reason),
        ]),
      ];
      if (errors.length) {
        const error = Components.Exception(
          "POP server settlement failed",
          errors[0]?.result || Cr.NS_ERROR_FAILURE
        );
        error.secondaryErrors = errors;
        throw error;
      }
    });
    return this._migrationDrain;
  }

  /**
   * Releases retained server state after its joined terminal and consumer.
   *
   * @param {nsISupports} nativeView - The same selected native owner.
   * @param {nsresult} settlementNsresult - The actual consumer result.
   */
  releaseMigrationDrain(nativeView, settlementNsresult) {
    validatePop3MigrationView(nativeView);
    if (this._migrationView != nativeView || !this._migrationDrain) {
      throw Components.Exception(
        "Unacquired server owner",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    if (Components.isSuccessCode(settlementNsresult)) {
      this._migrationView = null;
      this._migrationDrain = null;
      this._migrationMarkErrors = [];
      this._migrationRunErrors = [];
    }
  }
}

Pop3IncomingServer.prototype.classID = Components.ID(
  "{f99fdbf7-2e79-4ce3-9d94-7af3763b82fc}"
);
