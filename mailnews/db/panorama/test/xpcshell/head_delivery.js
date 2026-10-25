/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from ../../../../imap/test/unit/head_server.js */

/**
 * @typedef {object} DeliveryLane
 * @property {"mork"|"panorama"} backend - The expected DB backend.
 * @property {"mbox"|"maildir"|"none"} store - The expected store, or raw DB scope.
 */

const PanoramaDelivery = {
  /**
   * Reads the required lane independently of product preferences.
   *
   * @returns {DeliveryLane} The declared backend and store.
   */
  expectedLane() {
    const value = Services.env.get("PANORAMA_DELIVERY_EXPECT");
    Assert.ok(
      /^(mork|panorama):(mbox|maildir|none)$/.test(value),
      "PANORAMA_DELIVERY_EXPECT must specify backend:store"
    );
    const [backend, store] = value.split(":");
    return { backend, store };
  },

  /**
   * Starts the account manager and checks the active message DB service.
   * Call after creating the profile and preparing any startup fixtures.
   *
   * @param {"mork"|"panorama"} backend - The backend required by the case.
   * @returns {nsIMsgDBService} The active message DB service.
   */
  assertBackend(backend) {
    Assert.ok(
      backend == "mork" || backend == "panorama",
      "The case specifies a supported backend"
    );
    const { MailServices } = ChromeUtils.importESModule(
      "resource:///modules/MailServices.sys.mjs"
    );
    MailServices.accounts;
    const service = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    );
    const actualBackend =
      service instanceof Ci.nsIDatabaseCore ? "panorama" : "mork";
    info(
      "DELIVERY_BACKEND " + JSON.stringify({ expected: backend, actualBackend })
    );
    Assert.equal(
      Services.prefs.getBoolPref("mail.panorama.enabled", false),
      backend == "panorama",
      "The startup preference matches the backend required by the case"
    );
    Assert.equal(
      actualBackend,
      backend,
      "The active message DB service implements the required backend"
    );
    return service;
  },

  /**
   * Checks the folder's active DB service, store contract, and store type.
   * Opens the folder database and instantiates the store if needed.
   *
   * @param {nsIMsgFolder} folder - The folder used by the case.
   * @param {object} expected - The backend and store required by the case.
   * @param {"mork"|"panorama"} expected.backend - The required DB backend.
   * @param {"mbox"|"maildir"} expected.store - The required body store.
   * @returns {nsIMsgDatabase} The database returned by the active DB service.
   */
  assertFolder(folder, { backend, store }) {
    const service = this.assertBackend(backend);
    this._assertStore(folder, { backend, store });
    const db = folder.msgDatabase;
    Assert.ok(db, "The folder has an open message database");
    Assert.equal(
      service.openFolderDB(folder, false),
      db,
      "The folder database comes from the active message DB service"
    );
    return db;
  },

  /**
   * Checks the store without opening a database, including for server roots.
   *
   * @param {nsIMsgFolder} folder - The folder whose store is checked.
   * @param {DeliveryLane} lane - The required lane.
   */
  _assertStore(folder, { backend, store }) {
    const contracts = {
      mbox: "@mozilla.org/msgstore/berkeleystore;1",
      maildir: "@mozilla.org/msgstore/maildirstore;1",
    };
    Assert.ok(
      Object.hasOwn(contracts, store),
      "A folder requires a body store"
    );
    const server = folder.server;
    const contractBefore = server.getStringValue("storeContractID");
    const contractSource = Services.prefs.prefHasUserValue(
      "mail.server." + server.key + ".storeContractID"
    )
      ? "server"
      : contractBefore
        ? "inherited-default"
        : "absent";
    info(
      "DELIVERY_STORE_CONTRACT " +
        JSON.stringify({
          folderURI: folder.URI,
          contractBefore,
          contractSource,
          defaulted: !contractBefore,
        })
    );
    const actualStore = server.msgStore.storeType;
    info(
      "DELIVERY_FOLDER " +
        JSON.stringify({
          folderURI: folder.URI,
          backend,
          expectedStore: store,
          actualStore,
          contractBefore,
          contractSource,
          defaulted: !contractBefore,
        })
    );
    Assert.equal(
      actualStore,
      store,
      "The instantiated body store matches the lane"
    );
    if (contractBefore) {
      Assert.equal(
        contractBefore,
        contracts[store],
        "The configured store matches"
      );
    }
  },

  /**
   * Creates a local folder with production schema and registers account cleanup.
   * Requires head.js and a lane with a body store.
   *
   * @param {string} [name="compatibility"] - The new folder name.
   * @returns {{account: nsIMsgAccount, rootFolder: nsIMsgLocalMailFolder,
   *   folder: nsIMsgLocalMailFolder, db: nsIMsgDatabase,
   *   generator: MessageGenerator}} The created local fixture.
   */
  createLocalFixture(name = "compatibility") {
    const lane = this.expectedLane();
    Assert.notEqual(lane.store, "none", "Local fixtures require a body store");
    const { MailServices } = ChromeUtils.importESModule(
      "resource:///modules/MailServices.sys.mjs"
    );
    const { MessageGenerator } = ChromeUtils.importESModule(
      "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
    );
    do_get_profile();
    this.assertBackend(lane.backend);
    if (lane.backend == "panorama") {
      loadExistingDB();
    }
    const account = MailServices.accounts.createLocalMailAccount();
    registerCleanupFunction(() =>
      MailServices.accounts.removeAccount(account, false)
    );
    const rootFolder = account.incomingServer.rootFolder.QueryInterface(
      Ci.nsIMsgLocalMailFolder
    );
    const folder = rootFolder
      .createLocalSubfolder(name)
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    const db = this.assertFolder(folder, lane);
    return {
      account,
      rootFolder,
      folder,
      db,
      generator: new MessageGenerator(),
    };
  },

  /**
   * Creates an IMAP account/fake server and checks its root, backend, and store.
   * Requires head_server.js and preconfigured store preferences.
   *
   * @returns {{lane: DeliveryLane, service: nsIMsgDBService,
   *   core: nsIDatabaseCore|null, daemon: ImapDaemon, server: nsMailServer,
   *   account: nsIMsgAccount, incomingServer: nsIImapIncomingServer,
   *   rootFolder: nsIMsgImapMailFolder}} The created IMAP fixture.
   *   Cleanup is registered before account creation.
   */
  createImapFixture() {
    const lane = this.expectedLane();
    Assert.notEqual(lane.store, "none", "IMAP fixtures require a body store");
    const { MailServices } = ChromeUtils.importESModule(
      "resource:///modules/MailServices.sys.mjs"
    );
    const service = this.assertBackend(lane.backend);
    const core =
      lane.backend == "panorama"
        ? service.QueryInterface(Ci.nsIDatabaseCore)
        : null;
    const daemon = new ImapDaemon();
    const server = makeServer(daemon);
    let account, incomingServer;
    registerCleanupFunction(() => {
      try {
        const thread = Services.tm.currentThread;
        while (thread.hasPendingEvents()) {
          thread.processNextEvent(true);
        }
        if (incomingServer) {
          incomingServer.QueryInterface(Ci.nsIImapServerSink).abortQueuedUrls();
          incomingServer.closeCachedConnections();
        }
      } finally {
        try {
          server.resetTest();
        } finally {
          try {
            server.stop();
          } finally {
            if (account) {
              MailServices.accounts.removeAccount(account, false);
            }
          }
        }
      }
    });
    account = MailServices.accounts.createAccount();
    const identity = MailServices.accounts.createIdentity();
    account.addIdentity(identity);
    account.defaultIdentity = identity;
    info('DELIVERY_PHASE {"phase":"imap-factory"}');
    incomingServer = MailServices.accounts.createIncomingServer(
      "user",
      "localhost",
      "imap"
    );
    account.incomingServer = incomingServer;
    incomingServer.QueryInterface(Ci.nsIImapIncomingServer);
    incomingServer.port = server.port;
    incomingServer.password = "password";
    incomingServer.maximumConnectionsNumber = 1;
    incomingServer.useIdle = false;
    incomingServer.useCondStore = false;
    incomingServer.downloadOnBiff = false;
    incomingServer.offlineDownload = false;
    incomingServer.setBoolValue("autosync_offline_stores", false);
    const rootFolder = incomingServer.rootFolder;
    Assert.equal(incomingServer.type, "imap", "The account uses IMAP");
    Assert.ok(
      rootFolder instanceof Ci.nsIMsgImapMailFolder,
      "The root is an IMAP folder"
    );
    Assert.equal(
      rootFolder.server,
      incomingServer,
      "The root belongs to its server"
    );
    this._assertStore(rootFolder, lane);
    if (core) {
      Assert.greater(rootFolder.id, 0, "The root has a Panorama folder ID");
      Assert.equal(
        core.folderDB.getFolderChildNamed(0, incomingServer.key),
        rootFolder.id
      );
      Assert.equal(
        core.folderDB.getMsgFolderForFolder(rootFolder.id),
        rootFolder
      );
    }
    info('DELIVERY_PHASE {"phase":"imap-ready"}');
    return {
      lane,
      service,
      core,
      daemon,
      server,
      account,
      incomingServer,
      rootFolder,
    };
  },
};
