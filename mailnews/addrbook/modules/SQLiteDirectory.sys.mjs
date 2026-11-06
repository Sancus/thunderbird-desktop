/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddrBookDirectory } from "resource:///modules/AddrBookDirectory.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  admitWindowsMigrationPath:
    "resource:///modules/panorama/MigrationSource.sys.mjs",
  migrationPhysicalIdentity:
    "resource:///modules/panorama/MigrationSource.sys.mjs",
  AddrBookCard: "resource:///modules/AddrBookCard.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  newUID: "resource:///modules/AddrBookUtils.sys.mjs",
  parseMorkAddressBook:
    "resource:///modules/panorama/MorkAddressBookReader.sys.mjs",
});

var log = console.createInstance({
  prefix: "mail.addr_book",
  maxLogLevel: "Warn",
  maxLogLevelPref: "mail.addr_book.loglevel",
});

// Track all directories by filename, for SQLiteDirectory.forFile.
var directories = new Map();

// Keep track of all database connections, and close them at shutdown, since
// nothing else ever tells us to close them.
var connections = new Map();

/**
 * Bind text for a matching CAST(:parameter AS TEXT) without SQLite consuming a
 * leading BOM through its UTF-16 binding. Empty text uses the ordinary binder
 * because an empty blob binds as NULL. Other value types keep their binding.
 *
 * @param {mozIStorageBindingParams} params - Statement or parameter set.
 * @param {string} name - Declared parameter name.
 * @param {unknown} value - Value to bind.
 */
function bindValue(params, name, value) {
  if (typeof value == "string" && value.length) {
    params.bindUTF8StringAsBlobByName(name, value);
  } else {
    params.bindByName(name, value);
  }
}

/**
 * Opens an SQLite connection to `file`, caches the connection, and upgrades
 * the database schema if necessary.
 */
function openConnectionTo(file) {
  let connection = connections.get(file.path);
  if (!connection) {
    connection = Services.storage.openDatabase(file);
    initializeConnection(connection, file);
    connections.set(file.path, connection);
  }
  return connection;
}

/**
 * Initializes the normal address-book schema without registering a directory.
 *
 * @param {mozIStorageConnection} connection - Open database.
 * @param {nsIFile} file - File used for existing upgrade backups.
 */
function initializeConnection(connection, file) {
  const CURRENT_VERSION = 4;
  const fileVersion = connection.schemaVersion;

  // If we're upgrading the version, first create a backup.
  if (fileVersion > 0 && fileVersion < CURRENT_VERSION) {
    const backupFile = file.clone();
    backupFile.leafName = backupFile.leafName.replace(
      /\.sqlite$/,
      `.v${fileVersion}.sqlite`
    );
    backupFile.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o644);

    log.warn(`Backing up ${file.leafName} to ${backupFile.leafName}`);
    file.copyTo(null, backupFile.leafName);
  }

  switch (fileVersion) {
    case 0:
      connection.executeSimpleSQL("PRAGMA journal_mode=WAL");
      connection.executeSimpleSQL(
        "CREATE TABLE properties (card TEXT, name TEXT, value TEXT)"
      );
      connection.executeSimpleSQL(
        "CREATE TABLE lists (uid TEXT PRIMARY KEY, name TEXT, nickName TEXT, description TEXT)"
      );
      connection.executeSimpleSQL(
        "CREATE TABLE list_cards (list TEXT, card TEXT, PRIMARY KEY(list, card))"
      );
    // Falls through.
    case 1:
      connection.executeSimpleSQL(
        "CREATE INDEX properties_card ON properties(card)"
      );
      connection.executeSimpleSQL(
        "CREATE INDEX properties_name ON properties(name)"
      );
    // Falls through.
    case 2:
      connection.executeSimpleSQL("DROP TABLE IF EXISTS cards");
    // The lists table may have a localId column we no longer use, but
    // since SQLite can't drop columns it's not worth effort to remove it.
    // Falls through.
    case 3:
      // This version exists only to create an automatic backup before cards
      // are transitioned to vCard.
      connection.schemaVersion = CURRENT_VERSION;
      break;
  }
}

/**
 * Closes the SQLite connection to `file` and removes it from the cache.
 */
function closeConnectionTo(file) {
  const connection = connections.get(file.path);
  if (connection) {
    return new Promise(resolve => {
      connection.asyncClose({
        complete() {
          resolve();
        },
      });
      connections.delete(file.path);
    });
  }
  return Promise.resolve();
}

// Close all open connections at shut down time.
AsyncShutdown.profileBeforeChange.addBlocker(
  "Address Book: closing databases",
  async () => {
    const promises = [];
    for (const directory of directories.values()) {
      promises.push(directory.cleanUp());
    }
    await Promise.allSettled(promises);
  }
);

// Close a connection on demand. This serves as an escape hatch from C++ code.
Services.obs.addObserver(async file => {
  file.QueryInterface(Ci.nsIFile);
  await closeConnectionTo(file);
  Services.obs.notifyObservers(file, "addrbook-close-ab-complete");
}, "addrbook-close-ab");

/**
 * Adds SQLite storage to AddrBookDirectory.
 */
export class SQLiteDirectory extends AddrBookDirectory {
  init(uri) {
    const uriParts = /^[\w-]+:\/\/([\w\.-]+\.\w+)$/.exec(uri);
    if (!uriParts) {
      throw new Components.Exception(
        `Unexpected uri: ${uri}`,
        Cr.NS_ERROR_UNEXPECTED
      );
    }

    this._uri = uri;
    let fileName = uriParts[1];
    if (fileName.includes("/")) {
      fileName = fileName.substring(0, fileName.indexOf("/"));
    }

    for (const child of Services.prefs.getChildList("ldap_2.servers.")) {
      if (
        child.endsWith(".filename") &&
        Services.prefs.getStringPref(child) == fileName
      ) {
        this._dirPrefId = child.substring(0, child.length - ".filename".length);
        break;
      }
    }
    if (!this._dirPrefId) {
      throw Components.Exception(
        `Couldn't grab dirPrefId for uri=${uri}, fileName=${fileName}`,
        Cr.NS_ERROR_UNEXPECTED
      );
    }

    // Make sure we always have a file. If a file is not created, the
    // filename may be accidentally reused.
    const file = new lazy.FileUtils.File(
      PathUtils.join(PathUtils.profileDir, fileName)
    );
    if (!file.exists()) {
      file.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o644);
    }

    this._fileName = fileName;

    super.init(uri);

    directories.set(fileName, this);
    // Create the DB connection here already, to let init() throw on corrupt SQLite files.
    this._dbConnection;
  }
  async cleanUp() {
    await super.cleanUp();

    if (this.hasOwnProperty("_file")) {
      await closeConnectionTo(this._file);
      delete this._file;
    }

    directories.delete(this._fileName);
  }

  get _dbConnection() {
    this._file = new lazy.FileUtils.File(
      PathUtils.join(PathUtils.profileDir, this.fileName)
    );
    const connection = openConnectionTo(this._file);

    // SQLite cache size can be set by the cacheSize preference, in KiB.
    // The default is 5 MiB but this can be lowered to 1 MiB if wanted.
    // There is no maximum size.
    let cacheSize = this.getIntValue("cacheSize", 5120); // 5 MiB
    cacheSize = Math.max(cacheSize, 1024); // 1 MiB
    connection.executeSimpleSQL(`PRAGMA cache_size=-${cacheSize}`);

    Object.defineProperty(this, "_dbConnection", {
      enumerable: true,
      value: connection,
      writable: false,
    });
    return connection;
  }
  get lists() {
    const listCache = new Map();
    const selectStatement = this._dbConnection.createStatement(
      "SELECT uid, name, nickName, description FROM lists"
    );
    while (selectStatement.executeStep()) {
      listCache.set(selectStatement.row.uid, {
        uid: selectStatement.row.uid,
        name: selectStatement.row.name,
        nickName: selectStatement.row.nickName,
        description: selectStatement.row.description,
      });
    }
    selectStatement.finalize();

    Object.defineProperty(this, "lists", {
      enumerable: true,
      value: listCache,
      writable: false,
    });
    return listCache;
  }
  get cards() {
    const cardCache = new Map();
    const propertiesStatement = this._dbConnection.createStatement(
      "SELECT card, name, value FROM properties"
    );
    while (propertiesStatement.executeStep()) {
      const uid = propertiesStatement.row.card;
      if (!cardCache.has(uid)) {
        cardCache.set(uid, new Map());
      }
      const card = cardCache.get(uid);
      if (card) {
        card.set(propertiesStatement.row.name, propertiesStatement.row.value);
      }
    }
    propertiesStatement.finalize();

    Object.defineProperty(this, "cards", {
      enumerable: true,
      value: cardCache,
      writable: false,
    });
    return cardCache;
  }

  loadCardProperties(uid) {
    if (this.hasOwnProperty("cards")) {
      const cachedCard = this.cards.get(uid);
      if (cachedCard) {
        return new Map(cachedCard);
      }
    }
    const properties = new Map();
    const propertyStatement = this._dbConnection.createStatement(
      "SELECT name, value FROM properties WHERE card = CAST(:card AS TEXT)"
    );
    bindValue(propertyStatement, "card", uid);
    while (propertyStatement.executeStep()) {
      properties.set(propertyStatement.row.name, propertyStatement.row.value);
    }
    propertyStatement.finalize();
    return properties;
  }
  saveCardProperties(uid, properties) {
    try {
      this._dbConnection.beginTransaction();
      const deleteStatement = this._dbConnection.createStatement(
        "DELETE FROM properties WHERE card = CAST(:card AS TEXT)"
      );
      bindValue(deleteStatement, "card", uid);
      deleteStatement.execute();
      const insertStatement = this._dbConnection.createStatement(
        "INSERT INTO properties VALUES (CAST(:card AS TEXT), CAST(:name AS TEXT), CAST(:value AS TEXT))"
      );

      for (const [name, value] of properties) {
        if (value !== null && value !== undefined && value !== "") {
          bindValue(insertStatement, "card", uid);
          bindValue(insertStatement, "name", name);
          bindValue(insertStatement, "value", value);
          insertStatement.execute();
          insertStatement.reset();
        }
      }

      this._dbConnection.commitTransaction();
      deleteStatement.finalize();
      insertStatement.finalize();
    } catch (ex) {
      this._dbConnection.rollbackTransaction();
      throw ex;
    }
  }
  deleteCard(uid) {
    const deleteStatement = this._dbConnection.createStatement(
      "DELETE FROM properties WHERE card = CAST(:cardUID AS TEXT)"
    );
    bindValue(deleteStatement, "cardUID", uid);
    deleteStatement.execute();
    deleteStatement.finalize();
  }
  saveList(list) {
    // Ensure list cache exists.
    this.lists;

    const replaceStatement = this._dbConnection.createStatement(
      "REPLACE INTO lists (uid, name, nickName, description) " +
        "VALUES (CAST(:uid AS TEXT), CAST(:name AS TEXT), CAST(:nickName AS TEXT), CAST(:description AS TEXT))"
    );
    bindValue(replaceStatement, "uid", list._uid);
    bindValue(replaceStatement, "name", list._name);
    bindValue(replaceStatement, "nickName", list._nickName);
    bindValue(replaceStatement, "description", list._description);
    replaceStatement.execute();
    replaceStatement.finalize();

    this.lists.set(list._uid, {
      uid: list._uid,
      name: list._name,
      nickName: list._nickName,
      description: list._description,
    });
  }
  deleteList(uid) {
    const deleteListStatement = this._dbConnection.createStatement(
      "DELETE FROM lists WHERE uid = CAST(:uid AS TEXT)"
    );
    bindValue(deleteListStatement, "uid", uid);
    deleteListStatement.execute();
    deleteListStatement.finalize();

    if (this.hasOwnProperty("lists")) {
      this.lists.delete(uid);
    }

    this._dbConnection.executeSimpleSQL(
      "DELETE FROM list_cards WHERE list NOT IN (SELECT DISTINCT uid FROM lists)"
    );
  }
  /**
   * Adds cards to the database without individual notifications.
   *
   * @param {nsIAbCard[]} cards
   * @returns {Promise}
   */
  async bulkAddCards(cards) {
    if (this._readOnly) {
      throw new Components.Exception(
        "Directory is read-only",
        Cr.NS_ERROR_FAILURE
      );
    }
    return this.bulkAddCardsInternal(cards);
  }
  /**
   * The implementation of `bulkAddCards`, without a read-only check. This
   * must not be called directly except by subclasses when syncing with a
   * server. All other calls should go through `bulkAddCards`.
   *
   * @param {nsIAbCard[]} cards - The card to add.
   */
  async bulkAddCardsInternal(cards) {
    if (cards.length == 0) {
      return;
    }

    const usedUIDs = new Set(this.cards.keys());
    const propertiesStatement = this._dbConnection.createStatement(
      "INSERT INTO properties VALUES (CAST(:card AS TEXT), CAST(:name AS TEXT), CAST(:value AS TEXT))"
    );
    const propertiesArray = propertiesStatement.newBindingParamsArray();
    for (const card of cards) {
      let uid = card.UID;
      if (!uid || usedUIDs.has(uid)) {
        // A card cannot have the same UID as one that already exists.
        // Assign a new UID to avoid losing data.
        uid = lazy.newUID();
      }
      usedUIDs.add(uid);

      let cachedCard;
      if (this.hasOwnProperty("cards")) {
        cachedCard = new Map();
        this.cards.set(uid, cachedCard);
      }

      for (const [name, value] of this.prepareToSaveCard(card)) {
        const propertiesParams = propertiesArray.newBindingParams();
        bindValue(propertiesParams, "card", uid);
        bindValue(propertiesParams, "name", name);
        bindValue(propertiesParams, "value", value);
        propertiesArray.addParams(propertiesParams);

        if (cachedCard) {
          cachedCard.set(name, value);
        }
      }
    }
    try {
      this._dbConnection.beginTransaction();
      if (propertiesArray.length > 0) {
        propertiesStatement.bindParameters(propertiesArray);
        await new Promise((resolve, reject) => {
          propertiesStatement.executeAsync({
            handleError(error) {
              this._error = error;
            },
            handleCompletion(status) {
              if (status == Ci.mozIStorageStatementCallback.REASON_ERROR) {
                reject(
                  Components.Exception(this._error.message, Cr.NS_ERROR_FAILURE)
                );
              } else {
                resolve();
              }
            },
          });
        });
        propertiesStatement.finalize();
      }
      this._dbConnection.commitTransaction();

      Services.obs.notifyObservers(null, "addrbook-contacts-created", this.UID);
    } catch (ex) {
      this._dbConnection.rollbackTransaction();
      throw ex;
    }
  }

  /* nsIAbDirectory */

  get childCardCount() {
    const countStatement = this._dbConnection.createStatement(
      "SELECT COUNT(DISTINCT card) AS card_count FROM properties"
    );
    countStatement.executeStep();
    const count = countStatement.row.card_count;
    countStatement.finalize();
    return count;
  }
  getCardFromProperty(property, value, caseSensitive) {
    const sql = caseSensitive
      ? "SELECT card FROM properties WHERE name = CAST(:name AS TEXT) AND value = CAST(:value AS TEXT) LIMIT 1"
      : "SELECT card FROM properties WHERE name = CAST(:name AS TEXT) AND LOWER(value) = LOWER(CAST(:value AS TEXT)) LIMIT 1";
    const selectStatement = this._dbConnection.createStatement(sql);
    bindValue(selectStatement, "name", property);
    bindValue(selectStatement, "value", value);
    let result = null;
    if (selectStatement.executeStep()) {
      result = this.getCard(selectStatement.row.card);
    }
    selectStatement.finalize();
    return result;
  }
  getCardsFromProperty(property, value, caseSensitive) {
    const sql = caseSensitive
      ? "SELECT card FROM properties WHERE name = CAST(:name AS TEXT) AND value = CAST(:value AS TEXT)"
      : "SELECT card FROM properties WHERE name = CAST(:name AS TEXT) AND LOWER(value) = LOWER(CAST(:value AS TEXT))";
    const selectStatement = this._dbConnection.createStatement(sql);
    bindValue(selectStatement, "name", property);
    bindValue(selectStatement, "value", value);
    const results = [];
    while (selectStatement.executeStep()) {
      results.push(this.getCard(selectStatement.row.card));
    }
    selectStatement.finalize();
    return results;
  }

  /**
   * Creates a fresh, unregistered normal-schema file without address-book prefs.
   * Requires a caller-owned staging parent. Never overwrites an existing file;
   * retains failed initialization artifacts. The caller must close the returned
   * connection. This is storage preparation, not profile path admission/startup.
   *
   * @param {nsIFile} file - Fresh staging file beneath an existing private parent.
   * @returns {mozIStorageConnection} Uncached, caller-owned schema-4 connection.
   * @throws {Error} On an existing/unsafe path, missing parent or storage failure.
   */
  static createMigrationStage(file) {
    const target = file.clone();
    const future =
      AppConstants.platform == "win"
        ? lazy.admitWindowsMigrationPath(
            target,
            Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING
          )
        : null;
    let lease;
    let db;
    try {
      if (future?.exists) {
        throw Components.Exception(
          "Book stage already exists",
          Cr.NS_ERROR_FILE_ALREADY_EXISTS
        );
      }
      target.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600, true);
      lease =
        AppConstants.platform == "win"
          ? lazy.admitWindowsMigrationPath(
              target,
              Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING
            )
          : null;
      db = Services.storage.openUnsharedDatabase(target);
      initializeConnection(db, target);
      if (lease) {
        lazy.migrationPhysicalIdentity(lease);
      }
      return db;
    } catch (error) {
      try {
        db?.close();
      } catch (closeError) {
        console.error("Could not close failed book stage", closeError);
      }
      throw error;
    } finally {
      lease?.close();
      future?.close();
    }
  }

  /**
   * Reads a completed book and verifies its original bytes and scoped UID maps.
   * Never initializes a schema, imports a row or allocates an identity. A closed
   * stage must have no cached owner or data-bearing WAL/rollback journal.
   * Native empty WAL files and retained regular shared-memory indexes are safe.
   * A published retry can
   * reuse its known directory connection without changing that connection.
   *
   * @param {nsIFile} file - Existing regular schema-4 book file.
   * @param {Uint8Array} bytes - Complete original legacy snapshot.
   * @param {string} storageSourceId - Original committed storage token.
   * @param {object} [options] - Connection ownership requirements.
   * @param {boolean} [options.requireClosed=true] - Refuse a live directory.
   * @returns {object} Verified sourceId, sourceSha256, sourceSize and separate
   *   cards/lists [originalKey, UID] maps; also the Windows physical identity.
   * @throws {Error} On unsafe paths, missing provenance, a foreign transaction,
   *   changed contents or storage failure. The first read or close error wins.
   */
  static validateMigrationBook(
    file,
    bytes,
    storageSourceId,
    { requireClosed = true } = {}
  ) {
    if (
      typeof storageSourceId != "string" ||
      !storageSourceId ||
      !ArrayBuffer.isView(bytes) ||
      Object.prototype.toString.call(bytes) != "[object Uint8Array]" ||
      bytes.length > 64 * 1024 * 1024
    ) {
      throw new TypeError("Expected original book bytes and storage identity");
    }
    const target = file.QueryInterface(Ci.nsIFile).clone();
    for (let current = target; current; current = current.parent) {
      if (current.isSymlink()) {
        throw new Error("Book validation path contains a link");
      }
    }
    if (!target.exists() || !target.isFile()) {
      throw new Error("Book validation requires an existing regular file");
    }
    target.normalize();
    let db;
    let ownsConnection = false;
    let lease;
    let result;
    let failure;
    try {
      for (const [path, connection] of connections) {
        const active = new lazy.FileUtils.File(path);
        active.normalize();
        if (active.equals(target)) {
          if (requireClosed || (db && db !== connection)) {
            throw new Error("Book stage has an active directory connection");
          }
          db = connection;
        }
      }
      if (!db) {
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          const sidecar = new lazy.FileUtils.File(target.path + suffix);
          try {
            // lstat distinguishes dangling links from an absent auxiliary.
            if (
              sidecar.isSymlink() ||
              !sidecar.isFile() ||
              (suffix != "-shm" && sidecar.fileSize)
            ) {
              throw new Error(
                "Closed book stage has an unsafe or data-bearing SQLite sidecar"
              );
            }
          } catch (error) {
            if (error.result !== Cr.NS_ERROR_FILE_NOT_FOUND) {
              throw error;
            }
          }
        }
      }
      if (AppConstants.platform == "win") {
        lease = lazy.admitWindowsMigrationPath(
          target,
          Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
        );
        target.initWithPath(lease.canonicalPath);
      }
      const physical = lease ? lazy.migrationPhysicalIdentity(lease) : null;
      if (!db) {
        db = Services.storage.openUnsharedDatabase(target);
        ownsConnection = true;
        db.executeSimpleSQL("PRAGMA query_only=ON");
      }
      if (db.transactionInProgress || db.schemaVersion != 4) {
        throw new Error("Book validation requires a settled schema-4 database");
      }
      const tables = [
        "migration_source",
        "migration_records",
        "migration_properties",
        ...(physical ? ["migration_file_identity"] : []),
      ];
      if (!tables.every(name => db.tableExists(name))) {
        throw new Error("Incomplete book import provenance");
      }
      if (!physical && db.tableExists("migration_file_identity")) {
        throw new Error("Book stage requires its original Windows identity");
      }
      const original = Uint8Array.from(bytes);
      result = migrationReceipt(
        db,
        storageSourceId,
        migrationHash(original),
        original,
        lazy.parseMorkAddressBook(original),
        physical
      );
    } catch (error) {
      failure = error;
    } finally {
      for (const close of [
        () => {
          if (ownsConnection) {
            db?.close();
          }
        },
        () => lease?.close(),
      ]) {
        try {
          close();
        } catch (error) {
          if (failure) {
            console.error("Could not close book validation input", error);
          } else {
            failure = error;
          }
        }
      }
    }
    if (failure) {
      throw failure;
    }
    return result;
  }

  /**
   * Imports one complete legacy book into an unregistered, empty schema-4 stage.
   * The caller owns the connection, backup, profile lock and writer quiescence.
   * Keeps original bytes and exact active card/list/data cells separately from
   * normal vCard/list projections. Commits those rows, UID maps and the receipt
   * together. Attempts rollback on failure; retains the stage for receipt-based
   * retry. An identical completed repeat returns its original maps without
   * writes or notifications.
   * Never publishes a book or authorizes activation. Live-book notification and
   * platform path admission remain caller prerequisites, not completion evidence.
   *
   * @param {mozIStorageConnection} connection - Dedicated createMigrationStage
   *   connection, or its reopened normal schema-4 file. No SQLiteDirectory may
   *   have this file open. The caller retains ownership.
   * @param {Uint8Array} bytes - Complete read-only legacy snapshot.
   * @param {string} sourceId - Stable source-unit identity retained on retries.
   * @returns {{sourceId: string, sourceSha256: string, sourceSize: number,
   *   cards: [number, string][], lists: [number, string][]}} Committed source and
   *   scoped original-key/UID maps. On Windows, also includes versioned
   *   stagePhysicalIdentity (id and parentId), checked on every reopen.
   * @throws {Error} For incompatible/nonempty targets, changed repeats, unsupported
   *   data, foreign transactions or storage failure. No source files are touched.
   */
  static importMorkSnapshot(connection, bytes, sourceId) {
    const db = connection.QueryInterface(Ci.mozIStorageConnection);
    if (db.transactionInProgress) {
      throw Components.Exception(
        "Book import requires its own transaction",
        Cr.NS_ERROR_IN_PROGRESS
      );
    }
    if (
      !db.databaseFile ||
      db.schemaVersion != 4 ||
      typeof sourceId != "string" ||
      !sourceId
    ) {
      throw new Error(
        "Expected a dedicated schema-4 stage and source identity"
      );
    }
    const file = db.databaseFile.clone();
    const lease =
      AppConstants.platform == "win"
        ? lazy.admitWindowsMigrationPath(
            file,
            Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING
          )
        : null;
    try {
      const physical = lease ? lazy.migrationPhysicalIdentity(lease) : null;
      if (file.isSymlink()) {
        throw new Error("Book import stage is a linked file");
      }
      if (lease) {
        file.initWithPath(lease.canonicalPath);
      } else {
        file.normalize();
      }
      for (const path of connections.keys()) {
        const active = new lazy.FileUtils.File(path);
        active.normalize();
        if (active.equals(file)) {
          throw new Error("Book import stage is open in SQLiteDirectory");
        }
      }
      if (
        !ArrayBuffer.isView(bytes) ||
        Object.prototype.toString.call(bytes) != "[object Uint8Array]" ||
        bytes.length > 64 * 1024 * 1024
      ) {
        throw new TypeError("Expected a bounded Uint8Array book snapshot");
      }
      const original = Uint8Array.from(bytes);
      const book = lazy.parseMorkAddressBook(original);
      const sha256 = migrationHash(original);
      if (!physical && db.tableExists("migration_file_identity")) {
        throw new Error(
          "Book stage requires its original Windows physical identity"
        );
      }
      const tables = [
        ...(physical ? ["migration_file_identity"] : []),
        "migration_source",
        "migration_records",
        "migration_properties",
      ];
      if (tables.some(name => db.tableExists(name))) {
        if (!tables.every(name => db.tableExists(name))) {
          throw new Error("Incomplete book import provenance");
        }
        return migrationReceipt(db, sourceId, sha256, original, book, physical);
      }
      const count = db.createStatement(
        "SELECT (SELECT COUNT(*) FROM properties) + (SELECT COUNT(*) FROM lists) + (SELECT COUNT(*) FROM list_cards) AS total"
      );
      try {
        count.executeStep();
        if (count.row.total) {
          throw new Error("Book import stage is not empty");
        }
      } finally {
        count.finalize();
      }
      const records = [];
      const cardUIDs = new Map();
      const uids = new Set();
      const allocate = properties => {
        const uid = properties.get("UID") || lazy.newUID();
        if (uid.includes("\0") || uid.includes("/") || uids.has(uid)) {
          throw new Error("Unsupported or duplicate legacy book UID");
        }
        uids.add(uid);
        return uid;
      };
      const projector = new SQLiteDirectory();
      for (const card of book.cards) {
        const uid = allocate(card.properties);
        const properties = projectMigrationCard(projector, card, uid);
        records.push({ ...card, kind: "card", uid, projected: properties });
        cardUIDs.set(card.sourceKey, uid);
      }
      for (const list of book.lists) {
        const name = list.properties.get("ListName");
        if (
          !name ||
          name.includes("  ") ||
          /[,;"<>]/u.test(name) ||
          new Set(list.members).size != list.members.length
        ) {
          throw new Error("Unrepresentable legacy mailing list");
        }
        records.push({ ...list, kind: "list", uid: allocate(list.properties) });
      }
      for (const [sourceKey, properties] of book.metadata) {
        records.push({ sourceKey, properties, kind: "data", uid: null });
      }
      db.beginTransaction();
      try {
        if (physical) {
          db.executeSimpleSQL(
            "CREATE TABLE migration_file_identity(version INTEGER PRIMARY KEY CHECK(version=1), id TEXT NOT NULL, parentId TEXT NOT NULL)"
          );
          writeMigrationRow(
            db,
            "INSERT INTO migration_file_identity(version,id,parentId) VALUES(1,CAST(:id AS TEXT),CAST(:parentId AS TEXT))",
            { id: physical.id, parentId: physical.parentId }
          );
        }
        db.executeSimpleSQL(
          "CREATE TABLE migration_source (version INTEGER PRIMARY KEY CHECK(version=1), sourceId TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL)"
        );
        db.executeSimpleSQL(
          "CREATE TABLE migration_records (kind TEXT NOT NULL, sourceKey TEXT NOT NULL, uid TEXT UNIQUE, PRIMARY KEY(kind,sourceKey))"
        );
        db.executeSimpleSQL(
          "CREATE TABLE migration_properties (kind TEXT NOT NULL, sourceKey TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,sourceKey,name))"
        );
        for (const record of records) {
          const { kind, sourceKey, uid } = record;
          writeMigrationRow(
            db,
            "INSERT INTO migration_records VALUES(CAST(:kind AS TEXT),CAST(:sourceKey AS TEXT),CAST(:uid AS TEXT))",
            { kind, sourceKey: String(sourceKey), uid }
          );
          for (const [name, value] of record.properties) {
            writeMigrationRow(
              db,
              "INSERT INTO migration_properties VALUES(CAST(:kind AS TEXT),CAST(:sourceKey AS TEXT),CAST(:name AS TEXT),CAST(:value AS TEXT))",
              { kind, sourceKey: String(sourceKey), name, value }
            );
          }
          if (kind == "card") {
            for (const [name, value] of record.projected) {
              writeMigrationRow(
                db,
                "INSERT INTO properties VALUES(CAST(:card AS TEXT),CAST(:name AS TEXT),CAST(:value AS TEXT))",
                { card: uid, name, value }
              );
            }
          } else if (kind == "list") {
            writeMigrationRow(
              db,
              "INSERT INTO lists(uid,name,nickName,description) VALUES(CAST(:uid AS TEXT),CAST(:name AS TEXT),CAST(:nickName AS TEXT),CAST(:description AS TEXT))",
              {
                uid,
                name: record.properties.get("ListName"),
                nickName: record.properties.get("ListNickName") ?? "",
                description: record.properties.get("ListDescription") ?? "",
              }
            );
            for (const member of record.members) {
              writeMigrationRow(
                db,
                "INSERT INTO list_cards VALUES(CAST(:list AS TEXT),CAST(:card AS TEXT))",
                { list: uid, card: cardUIDs.get(member) }
              );
            }
          }
        }
        const receipt = db.createStatement(
          "INSERT INTO migration_source VALUES(1,CAST(:sourceId AS TEXT),CAST(:sha256 AS TEXT),:size,:bytes)"
        );
        try {
          bindValue(receipt, "sourceId", sourceId);
          bindValue(receipt, "sha256", sha256);
          bindValue(receipt, "size", original.length);
          receipt.bindBlobByName("bytes", original);
          receipt.execute();
        } finally {
          receipt.finalize();
        }
        const result = migrationReceipt(
          db,
          sourceId,
          sha256,
          original,
          book,
          physical
        );
        db.commitTransaction();
        return result;
      } catch (error) {
        try {
          db.rollbackTransaction();
        } catch (rollbackError) {
          console.error(
            "Could not roll back staged book import",
            rollbackError
          );
        }
        throw error;
      }
    } finally {
      lease?.close();
    }
  }

  /**
   * Reads immutable original cells for an imported card/list UID.
   * Missing properties stay absent; present empty values remain empty strings.
   * Normal edits use existing projections and do not rewrite this provenance.
   *
   * @param {string} uid - Destination UID returned in the import receipt.
   * @returns {Map<string, string>|null} Original cells, or null for a non-imported UID.
   */
  loadMigrationProperties(uid) {
    const db = this._dbConnection;
    if (!db.tableExists("migration_records")) {
      return null;
    }
    const record = db.createStatement(
      "SELECT kind,sourceKey FROM migration_records WHERE uid=CAST(:uid AS TEXT)"
    );
    let kind, sourceKey;
    try {
      bindValue(record, "uid", uid);
      if (!record.executeStep()) {
        return null;
      }
      ({ kind, sourceKey } = record.row);
    } finally {
      record.finalize();
    }
    const properties = new Map();
    const statement = db.createStatement(
      "SELECT name,value FROM migration_properties WHERE kind=CAST(:kind AS TEXT) AND sourceKey=CAST(:sourceKey AS TEXT)"
    );
    try {
      bindValue(statement, "kind", kind);
      bindValue(statement, "sourceKey", sourceKey);
      while (statement.executeStep()) {
        properties.set(statement.row.name, statement.row.value);
      }
    } finally {
      statement.finalize();
    }
    return properties;
  }

  static forFile(fileName) {
    return directories.get(fileName);
  }
}

SQLiteDirectory.prototype.classID = Components.ID(
  "{e96ee804-0bd3-472f-81a6-8a9d65277ad3}"
);

/** @param {Uint8Array} bytes - Original bytes. @returns {string} Exact SHA-256. */
function migrationHash(bytes) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(Ci.nsICryptoHash.SHA256);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

/** @param {mozIStorageConnection} db - Owned transaction. @param {string} sql - Fixed import SQL. @param {Record<string, string|number|null>} values - Bound values. */
function writeMigrationRow(db, sql, values) {
  const statement = db.createStatement(sql);
  try {
    for (const [name, value] of Object.entries(values)) {
      bindValue(statement, name, value);
    }
    statement.execute();
  } finally {
    statement.finalize();
  }
}

/**
 * Reads a completed scoped UID map and verifies its complete original bytes.
 *
 * @param {mozIStorageConnection} db - Dedicated stage connection.
 * @param {string} sourceId - Retained source identity.
 * @param {string} sha256 - Current input hash.
 * @param {Uint8Array} bytes - Current immutable input copy.
 * @param {{cards: {sourceKey: number}[], lists: {sourceKey: number}[]}} book -
 *   Validated original scoped keys.
 * @param {?object} physical - Native stage identity, required on Windows.
 * @returns {{sourceId: string, sourceSha256: string, sourceSize: number,
 *   cards: [number, string][], lists: [number, string][],
 *   stagePhysicalIdentity?: {version: number, id: string, parentId: string}}}
 *   Complete map and retained Windows identity when applicable.
 * @throws {Error} On changed or incomplete source/maps.
 */
function migrationReceipt(db, sourceId, sha256, bytes, book, physical) {
  if (physical) {
    const pin = db.createStatement(
      "SELECT version,id,parentId FROM migration_file_identity"
    );
    try {
      if (
        !pin.executeStep() ||
        pin.row.version != 1 ||
        pin.row.id !== physical.id ||
        pin.row.parentId !== physical.parentId ||
        pin.executeStep()
      ) {
        throw new Error("Book stage physical identity changed");
      }
    } finally {
      pin.finalize();
    }
  }
  const source = db.createStatement(
    "SELECT sourceId,sha256,size,bytes FROM migration_source WHERE version=1"
  );
  try {
    if (
      !source.executeStep() ||
      source.row.sourceId !== sourceId ||
      source.row.sha256 !== sha256 ||
      source.row.size != bytes.length
    ) {
      throw new Error("Book import source identity changed");
    }
    const original = {};
    source.getBlob(3, {}, original);
    if (
      original.value.length != bytes.length ||
      bytes.some((value, index) => value != original.value[index])
    ) {
      throw new Error("Book import original bytes changed");
    }
  } finally {
    source.finalize();
  }
  const result = {
    ...(physical ? { stagePhysicalIdentity: { ...physical } } : {}),
    sourceId,
    sourceSha256: sha256,
    sourceSize: bytes.length,
    cards: [],
    lists: [],
  };
  const statement = db.createStatement(
    "SELECT kind,sourceKey,uid FROM migration_records WHERE kind IN ('card','list') ORDER BY CAST(sourceKey AS INTEGER)"
  );
  try {
    while (statement.executeStep()) {
      const { kind, sourceKey, uid } = statement.row;
      result[kind == "card" ? "cards" : "lists"].push([Number(sourceKey), uid]);
    }
  } finally {
    statement.finalize();
  }
  for (const kind of ["cards", "lists"]) {
    const expected = new Set(book[kind].map(record => record.sourceKey));
    if (
      result[kind].length != expected.size ||
      result[kind].some(([key, uid]) => !expected.delete(key) || !uid)
    ) {
      throw new Error("Incomplete book import UID mapping");
    }
  }
  verifyMigrationBookStage(db, book, result);
  return result;
}

/**
 * Uses the normal card projection while retaining the legacy modification date.
 * Never allocates an identity or treats an old _vCard cell as a modern vCard.
 *
 * @param {SQLiteDirectory} projector - Normal card serializer.
 * @param {object} card - Validated original card and exact text properties.
 * @param {string} uid - Retained scoped UID, never regenerated on readback.
 * @returns {Map<string, string|number>} Normal projected properties.
 */
function projectMigrationCard(projector, card, uid) {
  const projected = new lazy.AddrBookCard();
  projected._uid = uid;
  projected._properties = new Map(card.properties);
  projected._properties.delete("_vCard");
  if (card.properties.has("RecordKey")) {
    const key = card.properties.get("RecordKey");
    if (!/^[0-9a-f]{0,8}$/iu.test(key)) {
      throw new Error("Unrepresentable legacy card RecordKey");
    }
    projected._properties.set("RecordKey", parseInt(key || "0", 16));
  }
  const properties = projector.prepareToSaveCard(projected, uid);
  properties.delete("LastModifiedDate");
  if (card.properties.has("LastModifiedDate")) {
    properties.set("LastModifiedDate", card.properties.get("LastModifiedDate"));
  }
  return properties;
}

/**
 * Checks a private, unpublished book stage before returning its receipt. Original
 * cells, normal projections and membership must still match the source snapshot.
 * Reconciliation is read-only; changed stages are retained for explicit repair.
 * This does not validate a live book after publication or permit activation.
 *
 * @param {mozIStorageConnection} db - Dedicated private stage connection.
 * @param {object} book - Actual parsed original snapshot.
 * @param {object} receipt - Complete persisted source-scoped UID maps.
 * @returns {void}
 * @throws {Error} For any changed, missing or extra stage row. Storage failures
 *   propagate unchanged; an existing commit is not rolled back or rewritten.
 */
function verifyMigrationBookStage(db, book, receipt) {
  const records = [];
  const raw = [];
  const properties = [];
  const lists = [];
  const members = new Map();
  const cardUIDs = new Map(receipt.cards);
  const listUIDs = new Map(receipt.lists);
  const projector = new SQLiteDirectory();
  const original = (kind, key, uid, cells) => {
    const sourceKey = String(key);
    if (
      uid !== null &&
      (uid.includes("\0") ||
        uid.includes("/") ||
        (cells.get("UID") && cells.get("UID") !== uid))
    ) {
      throw new Error("Staged book source UID differs");
    }
    records.push([kind, sourceKey, uid]);
    for (const [name, value] of cells) {
      raw.push([kind, sourceKey, name, value]);
    }
  };
  for (const card of book.cards) {
    const uid = cardUIDs.get(card.sourceKey);
    original("card", card.sourceKey, uid, card.properties);
    for (const [name, value] of projectMigrationCard(projector, card, uid)) {
      properties.push([uid, name, String(value)]);
    }
  }
  for (const list of book.lists) {
    const uid = listUIDs.get(list.sourceKey);
    original("list", list.sourceKey, uid, list.properties);
    lists.push([
      uid,
      list.properties.get("ListName"),
      list.properties.get("ListNickName") ?? "",
      list.properties.get("ListDescription") ?? "",
    ]);
    members.set(
      uid,
      list.members.map(key => cardUIDs.get(key))
    );
  }
  for (const [key, cells] of book.metadata) {
    original("data", key, null, cells);
  }
  const check = (sql, columns, expected, name) => {
    const missing = new Set(expected.map(row => JSON.stringify(row)));
    const statement = db.createStatement(sql);
    try {
      while (statement.executeStep()) {
        const row = columns.map(column => statement.row[column]);
        if (!missing.delete(JSON.stringify(row))) {
          throw new Error("Staged book differs: " + name);
        }
      }
      if (missing.size) {
        throw new Error("Staged book differs: " + name);
      }
    } finally {
      statement.finalize();
    }
  };
  check(
    "SELECT kind,sourceKey,uid FROM migration_records",
    ["kind", "sourceKey", "uid"],
    records,
    "records"
  );
  check(
    "SELECT kind,sourceKey,name,value FROM migration_properties",
    ["kind", "sourceKey", "name", "value"],
    raw,
    "raw properties"
  );
  check(
    "SELECT card,name,value FROM properties",
    ["card", "name", "value"],
    properties,
    "card projection"
  );
  check(
    "SELECT uid,name,nickName,description FROM lists",
    ["uid", "name", "nickName", "description"],
    lists,
    "list projection"
  );
  const positions = new Map();
  const statement = db.createStatement(
    "SELECT list,card FROM list_cards ORDER BY rowid"
  );
  try {
    while (statement.executeStep()) {
      const { list, card } = statement.row;
      const index = positions.get(list) ?? 0;
      if (!members.has(list) || members.get(list)[index] !== card) {
        throw new Error("Staged book differs: list membership");
      }
      positions.set(list, index + 1);
    }
    for (const [list, cards] of members) {
      if ((positions.get(list) ?? 0) !== cards.length) {
        throw new Error("Staged book differs: list membership");
      }
    }
  } finally {
    statement.finalize();
  }
}
