/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";
import {
  readMorkFolderImport,
  validateMorkFolderWindowsInventory,
} from "resource:///modules/panorama/MorkFolderImport.sys.mjs";
import { MigrationJournal } from "resource:///modules/panorama/MigrationJournal.sys.mjs";
import {
  convertMorkFolderSnapshot,
  convertMorkProtocolUnit,
  validateMorkFolderReceipt,
  validateMorkProtocolUnitReceipt,
} from "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs";
import {
  readMorkMigrationSource,
  readMorkAddressBookSource,
  readMorkFolderCacheSource,
  hashMigrationFile,
} from "resource:///modules/panorama/MigrationSource.sys.mjs";

import { getMorkThreadRelations } from "resource:///modules/panorama/MigrationMessageMap.sys.mjs";

import { verifyMigrationBackup } from "resource:///modules/panorama/MigrationBackup.sys.mjs";

import {
  parseJSONFolderCache,
  createMorkFolderCacheRequest,
  getMorkFolderCacheCells,
  validateMorkFolderCacheReceipt,
} from "resource:///modules/panorama/MorkFolderCache.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  withMigrationAddressBookPublication:
    "resource:///modules/AddrBookManager.sys.mjs",
  MailServices: "resource:///modules/MailServices.sys.mjs",
  SQLiteDirectory: "resource:///modules/SQLiteDirectory.sys.mjs",
  readLegacyGlodaMail:
    "resource:///modules/panorama/LegacyGlodaMailReader.sys.mjs",
  mapLegacyGlodaMail:
    "resource:///modules/panorama/LegacyGlodaMailReader.sys.mjs",
});

/**
 * Resumes the mail-import stage of an already backed-up, quiesced profile.
 * Reconciles core receipts before importing. Core must commit the receipt,
 * complete metadata and old/new key map atomically in its owned transaction.
 * Body files remain read-only inputs; no profile-wide SQL/body atomicity exists.
 *
 * @param {MigrationJournal} journal - Open journal under the profile lock.
 * @param {object} core - Target backend; createPanoramaMigrationTarget binds the native APIs.
 * @param {function(string, object): Promise<object|null>} core.findReceipt - Looks up
 *   the durable import token, including work committed before interruption.
 * @param {function(object): Promise<object>} core.importFolder - Imports token,
 *   source identity, destinationFolderId, summary and original thread relations.
 *   Rejects on failure; resolves only with its committed complete receipt.
 * @param {function(string,string[]): Promise<object|null>} [core.findProtocolUnitReceipt] -
 *   Reconciles a complete retained IMAP source unit.
 * @param {function(string,string[]): Promise<object>} [core.importProtocolUnit] -
 *   Commits the complete prepared IMAP source unit and receipt.
 * @param {AbortSignal} [signal] - Stop at the next settled import boundary.
 * @returns {Promise<void>} Mail sources checkpointed; validation waits for all books.
 */
export async function resumeMorkImports(journal, core, signal) {
  const checkCancelled = async () => {
    if (signal?.aborted && !journal.state.cancelled) {
      await journal.setCancelled(true);
    }
    if (journal.state.cancelled) {
      throw new DOMException("Migration cancelled", "AbortError");
    }
  };
  if (["validate", "activate", "complete"].includes(journal.state.stage)) {
    return;
  }
  if (journal.state.stage != "import") {
    throw new Error("Migration is not at the mail-import stage");
  }
  try {
    const settledUnits = new Set();
    for (const source of journal.state.sources) {
      await checkCancelled();
      if (source.protocol === "imap") {
        const group = source.protocolUnitId ?? "imap";
        if (settledUnits.has(group)) {
          continue;
        }
        if (
          typeof core.findProtocolUnitReceipt != "function" ||
          typeof core.importProtocolUnit != "function"
        ) {
          throw new Error(
            "Native complete protocol-unit migration is required"
          );
        }
        const ids = journal.state.sources
          .filter(
            member =>
              member.protocol === "imap" &&
              (member.protocolUnitId ?? "imap") === group
          )
          .map(member => member.id)
          .sort();
        const token = await journal.beginImportUnit(ids);
        let receipt = await core.findProtocolUnitReceipt(token, ids);
        if (!receipt) {
          if (
            journal.state.sources.some(
              member => ids.includes(member.id) && member.state === "imported"
            )
          ) {
            throw new Error("Core lost a committed migration protocol receipt");
          }
          await checkCancelled();
          receipt = await core.importProtocolUnit(token, ids);
        }
        // A real native commit is checkpointed for every member before cancel.
        await journal.recordImportUnit(token, receipt);
        settledUnits.add(group);
        await checkCancelled();
        continue;
      }
      const token = await journal.beginImport(source.id);
      let receipt = await core.findReceipt(token, {
        sourceId: source.id,
        sourceSha256: source.sha256,
        destinationFolderId: source.destinationFolderId,
      });
      if (!receipt) {
        if (source.state == "imported") {
          throw new Error("Core lost a committed migration receipt");
        }
        const { summary, identity } = await readMorkMigrationSource(
          source.path
        );
        if (
          identity.path != source.path ||
          identity.sha256 != source.sha256 ||
          identity.size != source.size ||
          !sameKeys(identity.messageKeys, source.messageKeys)
        ) {
          throw new Error("Migration snapshot differs from the journal plan");
        }
        const relations = getMorkThreadRelations(summary);
        await checkCancelled();
        receipt = await core.importFolder({
          token,
          sourceId: source.id,
          source: identity,
          destinationFolderId: source.destinationFolderId,
          summary,
          relations,
        });
      }
      // A cancellation after core commits must not hide committed mappings.
      await journal.recordImport(source.id, receipt);
      await checkCancelled();
    }
    if (
      [...(journal.state.books ?? []), ...(journal.state.caches ?? [])].every(
        unit => unit.state == "imported"
      )
    ) {
      await journal.finishStage("import");
    }
  } catch (error) {
    try {
      await journal.recordError(error);
    } catch (journalError) {
      console.error("Could not checkpoint migration error", journalError);
    }
    throw error;
  }
}

/**
 * Imports backed-up books into private staged databases, without publication.
 * Requires the actual held profile lock and quiesced source/stage writers.
 * A book's token is SQLiteDirectory's storageSourceId; its original ID remains
 * separate in the journal. Storage commits before the journal checkpoint.
 * Restart reopens that exact stage and reconciles its persisted UID maps.
 *
 * @param {MigrationJournal} journal - Open version2 journal with book units.
 * @param {nsIProfileLock} profileLock - Caller-held lock for the original profile.
 * @param {AbortSignal} [signal] - Cancellation at a settled book boundary.
 * @returns {Promise<void>} Checkpointed books; validation when all units settle.
 * @throws {Error} For unsupported paths, changed inputs or lost committed stages.
 */
export async function resumeMorkBookImports(journal, profileLock, signal) {
  if (AppConstants.platform == "win") {
    throw new Error("Windows book migration requires native reparse admission");
  }
  const lock = profileLock.QueryInterface(Ci.nsIProfileLock);
  const checkLock = () => {
    const directory = lock.directory.clone();
    if (directory.isSymlink()) {
      throw new Error("Migration profile lock directory is a link");
    }
    directory.normalize();
    if (!directory.equals(new FileUtils.File(journal.state.profilePath))) {
      throw new Error("Migration profile lock selects another profile");
    }
  };
  return resumeMorkBooksWithProfile(journal, checkLock, signal);
}

/**
 * Imports and checkpoints books while the supplied owner holds the profile.
 *
 * @param {MigrationJournal} journal - Backed-up book import journal.
 * @param {function():void} checkLock - Checks the owner's held profile and the
 *   exact journal root at every existing import checkpoint.
 * @param {AbortSignal} [signal] - Cancellation at a settled book boundary.
 * @returns {Promise<void>} Imported book receipts and settled stage checkpoint.
 */
async function resumeMorkBooksWithProfile(journal, checkLock, signal) {
  const checkCancelled = async () => {
    if (signal?.aborted && !journal.state.cancelled) {
      await journal.setCancelled(true);
    }
    if (journal.state.cancelled) {
      throw new DOMException("Migration cancelled", "AbortError");
    }
  };
  checkLock();
  if (!journal.state.books?.length) {
    return;
  }
  if (!["import", "validate"].includes(journal.state.stage)) {
    throw new Error("Migration is not at the book-import stage");
  }
  try {
    for (const book of journal.state.books) {
      await checkCancelled();
      checkLock();
      const token = await journal.beginBookImport(book.id);
      const roots = [journal.state.profilePath, ...journal.state.mailPaths].map(
        path => new FileUtils.File(path)
      );
      const sourceFile = new FileUtils.File(book.path);
      if (admittedFolderPath(sourceFile, roots) != book.path) {
        throw new Error("Migration book source path changed");
      }
      const { bytes, identity } = await readMorkAddressBookSource(book.path);
      if (
        identity.path != book.path ||
        identity.sha256 != book.sha256 ||
        identity.size != book.size ||
        !sameKeys(identity.cardKeys, book.cardKeys) ||
        !sameKeys(identity.listKeys, book.listKeys)
      ) {
        throw new Error(
          "Migration book snapshot differs from the journal plan"
        );
      }
      await checkCancelled();
      checkLock();
      if (admittedFolderPath(sourceFile, roots) != book.path) {
        throw new Error("Migration book source path changed");
      }
      const stage = new FileUtils.File(book.stagingPath);
      if (admittedFolderPath(stage, [stage.parent]) != book.stagingPath) {
        throw new Error("Migration book staging path changed");
      }
      const exists = stage.exists();
      if (book.state == "imported" && !exists) {
        throw new Error("Committed book stage is missing");
      }
      if (exists && (await IOUtils.stat(stage.path)).type != "regular") {
        throw new Error("Migration book stage is not a regular file");
      }
      let db;
      let receipt;
      let failure;
      try {
        db = exists
          ? Services.storage.openUnsharedDatabase(stage)
          : lazy.SQLiteDirectory.createMigrationStage(stage);
        if (book.state == "imported" && !db.tableExists("migration_source")) {
          throw new Error("Committed book storage receipt is missing");
        }
        const committed = lazy.SQLiteDirectory.importMorkSnapshot(
          db,
          bytes,
          token
        );
        receipt = {
          token,
          sourceId: book.id,
          storageSourceId: committed.sourceId,
          sourceSha256: committed.sourceSha256,
          sourceSize: committed.sourceSize,
          stagingPath: book.stagingPath,
          cards: committed.cards,
          lists: committed.lists,
          ...(identity.physicalIdentity
            ? {
                sourcePhysicalIdentity: identity.physicalIdentity,
                stagePhysicalIdentity: committed.stagePhysicalIdentity,
              }
            : {}),
        };
      } catch (error) {
        failure = error;
      } finally {
        try {
          db?.close();
        } catch (error) {
          if (failure) {
            console.error("Could not close failed book stage", error);
          } else {
            failure = error;
          }
        }
      }
      if (receipt) {
        // Settle known committed UIDs before reporting cancellation/close errors.
        try {
          await journal.recordBookImport(book.id, receipt);
        } catch (error) {
          if (failure) {
            console.error("Could not checkpoint committed book", error);
          } else {
            failure = error;
          }
        }
      }
      if (failure) {
        throw failure;
      }
      await checkCancelled();
    }
    if (
      journal.state.stage == "import" &&
      [...journal.state.sources, ...(journal.state.caches ?? [])].every(
        source => source.state == "imported"
      )
    ) {
      await journal.finishStage("import");
    }
  } catch (error) {
    try {
      await journal.recordError(error);
    } catch (journalError) {
      console.error("Could not checkpoint book migration error", journalError);
    }
    throw error;
  }
}

/**
 * Imports and publishes complete books in the selected startup profile.
 * The startup caller retains its native profile lock throughout this operation.
 * This entry never acquires or releases that process-lifetime lock. The caller
 * awaits imports, Manager adoption and journal writes before writers start.
 * Existing stage-only imports and the whole-profile activation hold remain.
 * A Manager commit precedes its journal write; a retry uses the original public
 * book identity and full scoped maps instead of importing or notifying twice.
 *
 * @param {MigrationJournal} journal - Actual backed-up import/validation journal.
 * @param {nsIToolkitProfile} profile - Actual startup-selected current profile.
 *   The caller retains the startup profile lock through all settled work.
 * @param {Map<string, string>} bookNames - Exact planned ID/display-name pairs.
 * @param {AbortSignal} [signal] - Cancellation after a settled book boundary.
 * @returns {Promise<object[]>} Actual Manager directories and publication maps.
 * @throws {Error} On unsupported admission, changed data, publication or journal
 *   failure. The original child error is preserved if error checkpointing fails.
 * @example
 * await resumeMorkBookImportsAndPublish(journal, profile,
 *   new Map([["original-book", "Imported address book"]]));
 */
export async function resumeMorkBookImportsAndPublish(
  journal,
  profile,
  bookNames,
  signal
) {
  if (AppConstants.platform == "win") {
    throw new Error("Windows book migration requires native reparse admission");
  }
  if (!(journal instanceof MigrationJournal)) {
    throw new TypeError("An actual migration journal is required");
  }
  return lazy.withMigrationAddressBookPublication(
    profile,
    async publication => {
      const checkLock = () => {
        const selected = publication.checkProfile();
        const current = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
        for (const file of [selected, current]) {
          for (let parent = file; parent; parent = parent.parent) {
            if (parent.isSymlink()) {
              throw new Error("Book publication profile contains a link");
            }
          }
          file.normalize();
        }
        if (
          !selected.equals(current) ||
          !selected.equals(new FileUtils.File(journal.state.profilePath))
        ) {
          throw new Error("Book publication requires the held current profile");
        }
      };
      checkLock();
      const initial = journal.state;
      if (
        !["import", "validate"].includes(initial.stage) ||
        !initial.books?.length ||
        Object.prototype.toString.call(bookNames) != "[object Map]"
      ) {
        throw new Error(
          "Book publication requires an explicit current book plan"
        );
      }
      const names = new Map(bookNames);
      const ids = new Set(initial.books.map(book => book.id));
      if (
        names.size !== ids.size ||
        [...names].some(
          ([id, name]) =>
            !ids.has(id) || typeof name != "string" || name.includes("\0")
        )
      ) {
        throw new Error("Book publication names differ from the exact plan");
      }
      const checkCancelled = async () => {
        if (signal?.aborted && !journal.state.cancelled) {
          await journal.setCancelled(true);
        }
        if (journal.state.cancelled) {
          throw new DOMException("Migration cancelled", "AbortError");
        }
      };
      try {
        await checkCancelled();
        for (const book of initial.books) {
          checkLock();
          await journal.beginBookPublication(book.id, names.get(book.id));
        }
        await resumeMorkBooksWithProfile(journal, checkLock, signal);
        const publications = [];
        for (const book of journal.state.books) {
          await checkCancelled();
          checkLock();
          const roots = [
            journal.state.profilePath,
            ...journal.state.mailPaths,
          ].map(path => new FileUtils.File(path));
          const source = new FileUtils.File(book.path);
          if (admittedFolderPath(source, roots) !== book.path) {
            throw new Error("Book publication source path changed");
          }
          const { bytes, identity } = await readMorkAddressBookSource(
            book.path
          );
          if (
            identity.path !== book.path ||
            identity.sha256 !== book.sha256 ||
            identity.size !== book.size ||
            !sameKeys(identity.cardKeys, book.cardKeys) ||
            !sameKeys(identity.listKeys, book.listKeys)
          ) {
            throw new Error("Book publication source differs from its plan");
          }
          const stage = new FileUtils.File(book.stagingPath);
          if (admittedFolderPath(stage, [stage.parent]) !== book.stagingPath) {
            throw new Error("Book publication staging path changed");
          }
          const checked = lazy.SQLiteDirectory.validateMigrationBook(
            stage,
            bytes,
            book.token,
            { requireClosed: true }
          );
          if (
            book.state != "imported" ||
            checked.sourceId !== book.receipt.storageSourceId ||
            checked.sourceSha256 !== book.receipt.sourceSha256 ||
            checked.sourceSize !== book.receipt.sourceSize ||
            !["cards", "lists"].every(
              kind =>
                JSON.stringify(checked[kind]) ===
                JSON.stringify(book.receipt[kind])
            )
          ) {
            throw new Error(
              "Book publication differs from its committed import"
            );
          }
          await checkCancelled();
          checkLock();
          const published = await publication.adopt({
            stageFile: stage,
            sourceBytes: bytes,
            receipt: book.receipt,
            bookUID: book.publication.bookUID,
            dirName: book.publication.dirName,
          });
          // Settle the real Manager commit even if an observer requested cancellation.
          await journal.recordBookPublication(book.id, published);
          publications.push(published);
          await checkCancelled();
        }
        return publications;
      } catch (error) {
        try {
          await journal.recordError(error);
        } catch (journalError) {
          console.error(
            "Could not checkpoint book publication error",
            journalError
          );
        }
        throw error;
      }
    }
  );
}

/**
 * Binds backed-up cache rows to explicit current native folder descriptors.
 * Requires an existing mail-plan database incarnation and the selected held
 * profile lock, with source/target writers quiesced. No setters, SQL writes,
 * checkpoint or activation occur here; resumeMorkCacheImports applies the
 * separately planned unit. Raw text remains separate from projections.
 *
 * @param {MigrationJournal} journal - Open backed-up import/validation journal.
 * @param {nsIDatabaseCore} core - Actual started target service.
 * @param {nsIProfileLock} profileLock - Caller-held selected profile lock.
 * @param {string} path - Original cache file covered by the complete backup.
 * @param {Map<string, {folder: nsIMsgFolder, descriptor: string}>} bindings -
 *   Every original key with its admitted canonical native cache descriptor.
 * @param {number} [requestVersion=2] - Reconciled version2; explicit1 retains
 *   original provenance-only plan semantics without upgrading old receipts.
 *   An original native JSON input uses explicit version3 reconciliation.
 * @param {?nsISupports} [startupOperation=null] - Native operation for the
 *   distinct startup caller; otherwise profileLock must be a genuine held lock.
 * @returns {Promise<object>} Owned source bytes/raw records and exact folder
 *   bindings/properties. This is read-only input, never an import completion.
 * @throws {Error} For unsupported paths, changed identity or incomplete mapping.
 */
export async function prepareMorkFolderCacheImport(
  journal,
  core,
  profileLock,
  path,
  bindings,
  requestVersion = 2,
  startupOperation = null
) {
  if (![1, 2, 3].includes(requestVersion)) {
    throw new Error("Unsupported native cache request version");
  }
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  const input = await readBoundMorkFolderCacheInput(
    journal,
    core,
    profileLock,
    path,
    startupOperation
  );
  const {
    databaseSourceId,
    roots,
    cache,
    bytes,
    identity,
    proof,
    checkTarget,
    checkInput,
  } = input;
  if (cache.format === "json") {
    if (requestVersion === 1) {
      throw new Error("Native JSON cache requires reconciled version3");
    }
    requestVersion = 3;
  } else if (requestVersion === 3) {
    throw new Error("Version3 requires an original JSON cache");
  }
  if (
    Object.prototype.toString.call(bindings) != "[object Map]" ||
    bindings.size != cache.entries.size
  ) {
    throw new Error("Incomplete native folder-cache mapping");
  }
  const destinations = new Set();
  const descriptors = new Set();
  const capture = () =>
    [...bindings].map(([key, binding]) => {
      if (!cache.entries.has(key)) {
        throw new Error("Unknown original folder-cache key");
      }
      const folder = binding.folder.QueryInterface(Ci.nsIMsgFolder);
      const id = folder.id;
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        destinations.has(id) ||
        database.folderDB.getMsgFolderForFolder(id) !== folder
      ) {
        throw new Error(
          "Folder-cache mapping has no unique current native identity"
        );
      }
      const isServer = folder.isServer;
      const storePath = admittedFolderPath(folder.filePath, roots);
      const cachePath = isServer
        ? storePath
        : admittedFolderPath(folder.summaryFile, roots);
      const descriptor = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(
        MailStringUtils.byteStringToUint8Array(
          new FileUtils.File(cachePath).persistentDescriptor
        )
      );
      if (descriptor !== binding.descriptor || descriptors.has(descriptor)) {
        throw new Error(
          "Folder-cache canonical descriptor changed or collides"
        );
      }
      destinations.add(id);
      descriptors.add(descriptor);
      return {
        originalKey: key,
        ...(requestVersion >= 2
          ? { originalSummaryPath: isServer ? "" : cachePath }
          : {}),
        id,
        isServer,
        descriptor,
        cachePath,
        storePath,
        uri: folder.URI,
        protocol: folder.incomingServerType,
        storeType: folder.msgStore.storeType,
      };
    });
  const folders = capture();
  for (const folder of folders) {
    for (const [file, types] of [
      [folder.cachePath, [folder.isServer ? "directory" : "regular"]],
      [folder.storePath, ["regular", "directory"]],
    ]) {
      if (
        (await IOUtils.exists(file)) &&
        !types.includes((await IOUtils.stat(file)).type)
      ) {
        throw new Error("Unsupported native folder-cache path type");
      }
    }
  }
  await checkInput();
  destinations.clear();
  descriptors.clear();
  if (JSON.stringify(capture()) !== JSON.stringify(folders)) {
    throw new Error("Native folder-cache bindings changed during preparation");
  }
  checkTarget();
  return {
    databaseSourceId,
    source: identity,
    bytes,
    records: structuredClone(cache.source),
    ...(requestVersion >= 2 ? { requestVersion, proof } : {}),
    ...(requestVersion === 3 ? { sourceFormat: "json" } : {}),
    folders: folders.map(folder => bindMorkFolderCacheRecord(folder, cache)),
  };
}

/**
 * Reads native JSON cache bytes under the existing selected-profile admission.
 * Historical Mork files keep their original parser and source identity.
 *
 * @param {string} path - Admitted original cache file.
 * @returns {Promise<{cache: object, bytes: Uint8Array, identity: object}>}
 *   Complete original rows, bytes and checked path/size/SHA-256.
 * @throws {Error} For changed input, malformed rows or unsupported cell values.
 */
async function readStartupFolderCacheSource(path) {
  if (PathUtils.filename(path) !== "folderCache.json") {
    return readMorkFolderCacheSource(path);
  }
  const file = startupSourceFile(path);
  const before = await IOUtils.stat(file.path);
  const limit = 64 * 1024 * 1024;
  if (before.type !== "regular" || before.size > limit) {
    throw new Error("Unsupported native JSON cache file");
  }
  const bytes = await IOUtils.read(file.path, { maxBytes: limit + 1 });
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(Ci.nsICryptoHash.SHA256);
  hash.update(bytes, bytes.length);
  const sha256 = Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
  const after = await IOUtils.stat(file.path);
  if (
    startupSourceFile(path).path !== file.path ||
    bytes.length !== before.size ||
    after.type !== "regular" ||
    after.size !== before.size ||
    after.lastModified !== before.lastModified ||
    (await hashMigrationFile(file.path)) !== sha256
  ) {
    throw new Error("Native JSON cache changed while reading");
  }
  return {
    cache: parseJSONFolderCache(bytes),
    bytes,
    identity: { path: file.path, size: bytes.length, sha256 },
  };
}

/**
 * Classifies a fully parsed empty JSON cache before the startup backup decision.
 * Native startup independently rechecks its unchanged bytes before any create.
 *
 * @param {string} path - Closed selected-profile original JSON cache.
 * @returns {boolean} Whether the complete original cache contains no rows.
 * @throws {Error} For links, changed files, malformed JSON or unsupported values.
 */
function startupJSONCacheIsEmpty(path) {
  const file = startupSourceFile(path);
  const size = file.fileSize;
  const modified = file.lastModifiedTime;
  if (!file.isFile() || size < 0 || size > 64 * 1024 * 1024) {
    throw new Error("Unsupported startup JSON cache file");
  }
  const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream
  );
  stream.init(file, 0x01, 0, 0);
  try {
    const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
      Ci.nsIBinaryInputStream
    );
    binary.setInputStream(stream);
    const bytes = new Uint8Array(binary.readByteArray(size));
    const parsed = parseJSONFolderCache(bytes);
    if (
      startupSourceFile(path).path !== file.path ||
      file.fileSize !== size ||
      file.lastModifiedTime !== modified
    ) {
      throw new Error("Startup JSON cache changed during classification");
    }
    return parsed.entries.size === 0;
  } finally {
    stream.close();
  }
}

/**
 * Verifies the selected cache bytes and complete backup without live bindings.
 * Committed version2 audits use the saved original paths after rename/retirement.
 * This read never grants authority to apply cache fields.
 *
 * @param {MigrationJournal} journal - Open journal under the selected profile lock.
 * @param {nsIDatabaseCore} core - Current native database incarnation.
 * @param {nsIProfileLock} profileLock - Held selected profile lock.
 * @param {string} path - Original backed-up cache path.
 * @param {?nsISupports} [startupOperation=null] - Actual native startup owner.
 * @returns {Promise<object>} Original bytes, parsed cells, proof and recheck callback.
 * @throws {Error} For changed inputs, backup, lock or database identity.
 */
async function readBoundMorkFolderCacheInput(
  journal,
  core,
  profileLock,
  path,
  startupOperation = null
) {
  if (AppConstants.platform == "win") {
    throw new Error(
      "Windows cache migration requires native reparse admission"
    );
  }
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  const lock = startupOperation
    ? null
    : profileLock.QueryInterface(Ci.nsIProfileLock);
  const state = journal.state;
  const databaseSourceId = database.sourceId;
  const roots = [state.profilePath, ...state.mailPaths].map(
    root => new FileUtils.File(root)
  );
  const checkTarget = () => {
    const current = journal.state;
    const selected = new FileUtils.File(PathUtils.profileDir);
    const directory = startupOperation
      ? startupMigrationDirectory(journal, database, startupOperation)
      : lock.directory.clone();
    if (directory.isSymlink() || selected.isSymlink()) {
      throw new Error("Migration cache profile contains a link");
    }
    directory.normalize();
    selected.normalize();
    if (!directory.equals(roots[0]) || !selected.equals(roots[0])) {
      throw new Error("Cache target is not the held selected profile");
    }
    if (
      database !==
        Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
          Ci.nsIDatabaseCore
        ) ||
      !databaseSourceId ||
      database.sourceId !== databaseSourceId ||
      (!current.sources.length &&
        (!startupOperation ||
          current.version !== 7 ||
          !current.startup?.bound ||
          current.startup.databaseSourceId !== databaseSourceId)) ||
      current.sources.some(
        source => source.databaseSourceId !== databaseSourceId
      ) ||
      current.profilePath !== state.profilePath ||
      JSON.stringify(current.backup) !== JSON.stringify(state.backup) ||
      current.cancelled ||
      !["import", "validate"].includes(current.stage)
    ) {
      throw new Error("Cache target differs from the retained migration plan");
    }
  };
  checkTarget();
  if (!PathUtils.isAbsolute(path)) {
    throw new Error("Migration cache path must be absolute");
  }
  const original = new FileUtils.File(path);
  const canonical = admittedFolderPath(original, roots);
  const { cache, bytes, identity } =
    await readStartupFolderCacheSource(canonical);
  const backup = await verifyMigrationBackup(state.backupPath);
  if (
    backup.path !== state.backup?.path ||
    backup.sha256 !== state.backup.sha256
  ) {
    throw new Error("Migration cache backup identity changed");
  }
  const manifest = await IOUtils.readJSON(backup.path);
  if (
    !manifest.roots.some(root =>
      root.entries.some(
        entry =>
          entry.type == "regular" &&
          entry.size === identity.size &&
          entry.sha256 === identity.sha256 &&
          new FileUtils.File(
            PathUtils.join(root.source, ...entry.parts)
          ).equals(new FileUtils.File(identity.path))
      )
    )
  ) {
    throw new Error(
      "Migration cache source is not covered by the verified backup"
    );
  }
  const manifestInfo = await IOUtils.stat(backup.path);
  if (manifestInfo.type != "regular") {
    throw new Error("Migration cache backup manifest is not a regular file");
  }
  const proof = {
    profilePath: state.profilePath,
    manifest: {
      path: backup.path,
      size: manifestInfo.size,
      sha256: backup.sha256,
    },
  };
  const checkInput = async () => {
    checkTarget();
    if (
      admittedFolderPath(original, roots) !== identity.path ||
      (await IOUtils.computeHexDigest(identity.path, "sha256")) !==
        identity.sha256 ||
      (await IOUtils.computeHexDigest(backup.path, "sha256")) !== backup.sha256
    ) {
      throw new Error("Migration cache input changed during preparation");
    }
    if ((await IOUtils.stat(backup.path)).size !== proof.manifest.size) {
      throw new Error("Migration cache backup manifest size changed");
    }
    checkTarget();
  };
  await checkInput();
  return {
    databaseSourceId,
    roots,
    cache,
    bytes,
    identity,
    proof,
    checkTarget,
    checkInput,
  };
}

/**
 * Copies one original cache row onto its retained physical destination binding.
 *
 * @param {object} folder - Native folder binding.
 * @param {object} cache - Parsed complete original cache.
 * @returns {object} Binding with exact original row key and presence-sensitive cells.
 * @throws {Error} When a retained original key no longer exists.
 */
function bindMorkFolderCacheRecord(folder, cache) {
  const entry = cache.entries.get(folder.originalKey);
  if (!entry) {
    throw new Error("Cache snapshot differs from the journal plan");
  }
  return {
    ...folder,
    ...(Object.hasOwn(entry, "sourceKey")
      ? { sourceKey: entry.sourceKey }
      : {}),
    properties: [...entry.properties].map(([name, text]) => ({
      name,
      text,
      ...(typeof entry.values[name] == "number"
        ? { integer: entry.values[name] }
        : {}),
    })),
  };
}

/**
 * Applies supported cache cells through native SQL receipts, then checkpoints.
 * The caller retains the selected profile lock and quiesces source/target writers.
 * Version2 reconciles eligible fields against native origin and source proof.
 * Version3 applies the same checks to explicit native JSON cache entries.
 * Committed version1 plans retain their original provenance-only semantics.
 *
 * @param {MigrationJournal} journal - Explicit version5 cache plan.
 * @param {nsIDatabaseCore} core - Actual native cache receiver.
 * @param {nsIProfileLock} profileLock - Held selected profile lock.
 * @param {function(string): Map<string, object>} resolveBindings - Exact original-key bindings.
 * @param {AbortSignal} [signal] - Cancellation at settled commit boundaries.
 * @param {?nsISupports} [startupOperation=null] - Native startup operation.
 * @returns {Promise<void>} Supported cache units checkpointed; no activation.
 */
export async function resumeMorkCacheImports(
  journal,
  core,
  profileLock,
  resolveBindings,
  signal,
  startupOperation = null
) {
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  if (
    AppConstants.platform == "win" ||
    typeof database.importFolderCacheMetadata != "function" ||
    typeof database.getFolderCacheImportReceipt != "function"
  ) {
    throw new Error("Native Unix cache import/receipt APIs are required");
  }
  const checkCancelled = async () => {
    if (signal?.aborted && !journal.state.cancelled) {
      await journal.setCancelled(true);
    }
    if (journal.state.cancelled) {
      throw new DOMException("Migration cancelled", "AbortError");
    }
  };
  if (!journal.state.caches?.length) {
    throw new Error("Migration has no explicit cache plan");
  }
  if (!["import", "validate"].includes(journal.state.stage)) {
    throw new Error("Migration is not at the cache-import stage");
  }
  try {
    for (const cache of journal.state.caches) {
      await checkCancelled();
      if (cache.requestVersion >= 2) {
        const input = await readBoundMorkFolderCacheInput(
          journal,
          database,
          profileLock,
          cache.path,
          startupOperation
        );
        if (input.cache.entries.size !== cache.folders.length) {
          throw new Error("Cache snapshot differs from the journal plan");
        }
        const current = {
          ...cache,
          ...input.identity,
          databaseSourceId: input.databaseSourceId,
          proof: input.proof,
          folders: cache.folders.map(folder =>
            bindMorkFolderCacheRecord(folder, input.cache)
          ),
        };
        if (
          JSON.stringify(createMorkFolderCacheRequest(current)) !==
            JSON.stringify(createMorkFolderCacheRequest(cache)) ||
          JSON.stringify(getMorkFolderCacheCells(current.folders)) !==
            JSON.stringify(getMorkFolderCacheCells(cache.folders))
        ) {
          throw new Error("Cache snapshot differs from the journal plan");
        }
        const receipt = database.getFolderCacheImportReceipt(
          createMorkFolderCacheRequest(cache)
        );
        if (receipt !== null) {
          const checked = validateMorkFolderCacheReceipt(cache, receipt);
          await input.checkInput();
          await journal.beginCacheImport(cache.id);
          await journal.recordCacheImport(cache.id, checked);
          await checkCancelled();
          continue;
        }
        if (cache.state == "imported") {
          throw new Error("Native database lost a committed cache receipt");
        }
      }
      const snapshot = await prepareMorkFolderCacheImport(
        journal,
        database,
        profileLock,
        cache.path,
        await resolveBindings(cache.id),
        cache.requestVersion ?? 1,
        startupOperation
      );
      const current = {
        ...cache,
        ...snapshot.source,
        folders: snapshot.folders,
        databaseSourceId: snapshot.databaseSourceId,
        ...(snapshot.requestVersion >= 2 ? { proof: snapshot.proof } : {}),
      };
      const request = createMorkFolderCacheRequest(cache);
      const actual = createMorkFolderCacheRequest(current);
      const sorted = folders => folders.toSorted((a, b) => a.id - b.id);
      if (
        JSON.stringify({ ...request, folders: sorted(request.folders) }) !==
          JSON.stringify({ ...actual, folders: sorted(actual.folders) }) ||
        JSON.stringify(getMorkFolderCacheCells(cache.folders)) !==
          JSON.stringify(getMorkFolderCacheCells(current.folders))
      ) {
        throw new Error("Cache snapshot differs from the journal plan");
      }
      await checkCancelled();
      await journal.beginCacheImport(cache.id);
      const directory = startupOperation
        ? startupMigrationDirectory(journal, database, startupOperation)
        : profileLock.QueryInterface(Ci.nsIProfileLock).directory.clone();
      directory.normalize();
      if (
        !directory.equals(new FileUtils.File(journal.state.profilePath)) ||
        database.sourceId !== cache.databaseSourceId
      ) {
        throw new Error("Cache target changed before native import");
      }
      let receipt = database.getFolderCacheImportReceipt(request);
      if (receipt === null) {
        if (cache.state == "imported") {
          throw new Error("Native database lost a committed cache receipt");
        }
        receipt = database.importFolderCacheMetadata(request);
      }
      receipt = validateMorkFolderCacheReceipt(cache, receipt);
      // A native commit and this journal write are separate durable operations.
      await journal.recordCacheImport(cache.id, receipt);
      await checkCancelled();
    }
    if (
      journal.state.stage == "import" &&
      [...journal.state.sources, ...(journal.state.books ?? [])].every(
        unit => unit.state == "imported"
      )
    ) {
      await journal.finishStage("import");
    }
  } catch (error) {
    try {
      await journal.recordError(error);
    } catch (journalError) {
      console.error("Could not checkpoint cache migration error", journalError);
    }
    throw error;
  }
}

/**
 * Reads backed-up Gloda mail text and joins it to committed native imports.
 * Retains every raw record, excluded row and attribute definition. Resolves
 * physical folder/key locations before corroborating the original Message-ID.
 * Requires the held selected-profile lock and quiesced source/backup writers.
 * Windows retains native path leases through the read and requires journal4,
 * backup3 and complete version2 import receipts. Releases its own leases on exit;
 * the caller retains the profile lock.
 * Never imports, checkpoints, indexes text or authorizes profile activation.
 * Unknown eligibility remains a decision for the current search-policy owner.
 *
 * @param {MigrationJournal} journal - Open journal with imported mail sources.
 * @param {nsIDatabaseCore} core - Actual started Panorama database.
 * @param {function(string): (nsIMsgFolder|Promise<nsIMsgFolder>)} resolveFolder -
 *   Resolves each journal source ID to its original native folder.
 * @param {nsIProfileLock} profileLock - Caller-held selected-profile lock.
 * @param {string} path - Gloda database file inside the verified complete backup.
 * @returns {Promise<object>} Schema30 snapshot, mapped and excluded records,
 *   complete native receipts, database identity and original backup location.
 * @throws {Error} For unsupported paths/schema, missing or conflicting receipts,
 *   changed source/journal/database identity, or a released/unrelated lock.
 */
export async function readLegacyGlodaMailRecovery(
  journal,
  core,
  resolveFolder,
  profileLock,
  path
) {
  const windows = AppConstants.platform == "win";
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  if (
    database !==
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(Ci.nsIDatabaseCore)
  ) {
    throw new Error("Native Panorama recovery backend is required");
  }
  const state = journal.state;
  if (
    !["import", "validate", "activate", "complete"].includes(state.stage) ||
    state.sources.some(source => source.state != "imported") ||
    !state.backup
  ) {
    throw new Error("Gloda recovery requires backed-up committed mail imports");
  }
  if (
    windows &&
    (!(journal instanceof MigrationJournal) || state.version !== 4)
  ) {
    throw new Error("Windows migration requires a backed-up version4 journal");
  }
  const lock = profileLock.QueryInterface(Ci.nsIProfileLock);
  const databaseSourceId = database.sourceId;
  const before = JSON.stringify(state);
  const fs = windows
    ? Cc["@mozilla.org/mailnews/panorama-migration-file-system;1"].getService(
        Ci.nsIPanoramaMigrationFileSystem
      )
    : null;
  const leases = [];
  const retain = (file, root, kind, expected) => {
    const lease = fs.admit(file, root, kind);
    leases.push(lease);
    fs.validate(lease);
    if (
      expected &&
      (lease.identity !== expected.id ||
        lease.parentIdentity !== expected.parentId ||
        lease.rootIdentity !== expected.rootId)
    ) {
      throw new Error("Gloda recovery source physical identity changed");
    }
    return lease;
  };
  try {
    let selectedLease;
    if (windows) {
      const root = state.originalRoots.find(
        item => item.canonicalPath === state.profilePath
      );
      if (!root) {
        throw new Error("Migration profile has no original admitted root");
      }
      selectedLease = retain(
        new FileUtils.File(PathUtils.profileDir),
        new FileUtils.File(root.originalPath),
        fs.KIND_DIRECTORY
      );
      if (
        selectedLease.canonicalPath !== state.profilePath ||
        selectedLease.identity !== state.profilePhysicalIdentity.id ||
        selectedLease.parentIdentity !==
          state.profilePhysicalIdentity.parentId ||
        selectedLease.rootIdentity !== root.physicalIdentity.id
      ) {
        throw new Error("Gloda recovery requires the held selected profile");
      }
    }
    const check = () => {
      const directory = lock.directory.clone();
      if (windows) {
        // Admit the lock's actual directory before comparing canonical paths.
        const current = fs.admit(directory, directory, fs.KIND_DIRECTORY);
        try {
          fs.validate(current);
          if (
            current.canonicalPath !== selectedLease.canonicalPath ||
            current.identity !== selectedLease.identity ||
            current.parentIdentity !== selectedLease.parentIdentity
          ) {
            throw new Error(
              "Gloda recovery requires the held selected profile"
            );
          }
          for (const lease of leases) {
            fs.validate(lease);
          }
        } finally {
          current.close();
        }
      } else {
        const selected = new FileUtils.File(PathUtils.profileDir);
        if (selected.isSymlink() || directory.isSymlink()) {
          throw new Error("Gloda recovery profile contains a link");
        }
        selected.normalize();
        directory.normalize();
        if (
          !selected.equals(new FileUtils.File(state.profilePath)) ||
          !selected.equals(directory)
        ) {
          throw new Error("Gloda recovery requires the held selected profile");
        }
      }
      if (
        database.sourceId !== databaseSourceId ||
        JSON.stringify(journal.state) !== before
      ) {
        throw new Error("Gloda recovery journal/database identity changed");
      }
    };
    check();
    const backupPath = PathUtils.parent(state.backup.path);
    let sourcePath;
    if (windows) {
      const root = retain(
        new FileUtils.File(state.backupPath),
        new FileUtils.File(state.backupPath),
        fs.KIND_DIRECTORY
      );
      if (root.canonicalPath !== backupPath) {
        throw new Error("Gloda recovery backup identity changed");
      }
      retain(
        new FileUtils.File(state.backup.path),
        new FileUtils.File(state.backupPath),
        fs.KIND_FILE
      );
      const source = retain(
        new FileUtils.File(path),
        new FileUtils.File(state.backupPath),
        fs.KIND_FILE
      );
      sourcePath = source.canonicalPath;
      for (const item of state.sources) {
        validateMorkFolderWindowsInventory(item.inventory);
        for (const [name, original] of Object.entries(
          item.inventory.windowsAdmission
        )) {
          const lease = retain(
            new FileUtils.File(original.originalPath),
            new FileUtils.File(original.originalRoot),
            original.id ? fs.KIND_FILE : fs.KIND_FILE_OR_MISSING,
            original
          );
          if (name == "summary" && lease.canonicalPath !== item.path) {
            throw new Error("Gloda recovery source physical identity changed");
          }
        }
      }
    }
    const backup = await verifyMigrationBackup(backupPath);
    check();
    if (
      backup.path !== state.backup.path ||
      backup.sha256 !== state.backup.sha256
    ) {
      throw new Error("Gloda recovery backup identity changed");
    }
    sourcePath ??= admittedFolderPath(new FileUtils.File(path), [
      new FileUtils.File(PathUtils.parent(backup.path)),
    ]);
    const manifest = await IOUtils.readJSON(backup.path);
    check();
    if (
      windows &&
      (manifest.version !== 3 ||
        JSON.stringify(manifest.originalRoots) !==
          JSON.stringify(state.originalRoots))
    ) {
      throw new Error("Windows migration backup identity changed");
    }
    const entries = [];
    for (const root of manifest.roots) {
      for (const entry of root.entries) {
        if (
          entry.type == "regular" &&
          PathUtils.join(backupPath, root.directory, ...entry.parts) ===
            sourcePath
        ) {
          entries.push({ root, entry });
        }
      }
    }
    if (entries.length != 1) {
      throw new Error("Gloda recovery file is not a unique backed-up input");
    }
    const { root, entry } = entries[0];
    const snapshot = await lazy.readLegacyGlodaMail(sourcePath);
    check();
    if (
      snapshot.source.size !== entry.size ||
      snapshot.source.sha256 !== entry.sha256
    ) {
      throw new Error(
        "Gloda recovery snapshot differs from the complete backup"
      );
    }
    const folders = new Map();
    for (const source of state.sources) {
      folders.set(
        source.id,
        (await resolveFolder(source.id)).QueryInterface(Ci.nsIMsgFolder)
      );
      check();
    }
    const target = (
      windows
        ? createWindowsPanoramaMigrationTarget
        : createPanoramaMigrationTarget
    )(journal, database, id => folders.get(id), lock);
    const bindings = [];
    const receipts = new Map();
    for (const source of state.sources) {
      const receipt = await target.findReceipt(source.token, {
        sourceId: source.id,
        sourceSha256: source.sha256,
        destinationFolderId: source.destinationFolderId,
      });
      check();
      if (receipt === null) {
        throw new Error("Native database lost a committed Gloda mail binding");
      }
      if (
        receipt.databaseSourceId !== databaseSourceId ||
        receipt.token !== source.receipt?.token ||
        receipt.sourceSha256 !== source.receipt?.sourceSha256 ||
        receipt.folderId !== source.receipt?.folderId ||
        JSON.stringify(receipt.keys) !== JSON.stringify(source.receipt?.keys)
      ) {
        throw new Error(
          "Native Gloda mail receipt differs from its checkpoint"
        );
      }
      receipts.set(source.id, receipt);
      bindings.push({
        folderURI: folders.get(source.id).URI,
        source,
        originalSummary: await readMorkMigrationSource(source.path),
      });
      check();
    }
    const result = lazy.mapLegacyGlodaMail(snapshot, bindings);
    if ((await hashMigrationFile(backup.path)) !== backup.sha256) {
      throw new Error("Gloda recovery backup identity changed");
    }
    check();
    return {
      snapshot,
      backup,
      originalDatabasePath: PathUtils.join(root.source, ...entry.parts),
      mapped: result.mapped.map(row => ({
        ...row,
        sourceId: databaseSourceId,
        provenance: {
          ...row.provenance,
          originalDatabasePath: PathUtils.join(root.source, ...entry.parts),
          backup: structuredClone(backup),
          importReceipt: structuredClone(
            receipts.get(row.provenance.sourceFolderId)
          ),
        },
      })),
      excluded: result.excluded,
    };
  } finally {
    for (const lease of leases.reverse()) {
      lease.close();
    }
  }
}

/**
 * Binds the sequential coordinator to the real version1 native import APIs.
 * Reads and accounts every supported source record before native lookup/import.
 * Requires the actual profile lock plus quiesced profile/external writers; the
 * caller retains the lock through the coordinator's receipt checkpoint.
 * Requires the native Unix canonical-path receiver. Admits summary/store paths
 * only beneath the backed-up profile/mail roots. Does not activate the profile
 * or provide Windows reparse admission.
 *
 * @param {MigrationJournal} journal - Open durable journal with retained databaseSourceId pins.
 * @param {nsIDatabaseCore} core - Actual started Panorama database.
 * @param {function(string): (nsIMsgFolder|Promise<nsIMsgFolder>)} resolveFolder -
 *   Resolves a journal source ID to its actual original native folder.
 * @param {nsIProfileLock} profileLock - Caller-held lock for the journal profile.
 * @returns {object} findReceipt/importFolder boundary for resumeMorkImports.
 * @throws {Error} On missing APIs/pins/lock, changed identity or unsupported paths/records.
 */
export function createPanoramaMigrationTarget(
  journal,
  core,
  resolveFolder,
  profileLock
) {
  return bindPanoramaMigrationTarget(
    journal,
    core,
    resolveFolder,
    profileLock,
    false
  );
}

/**
 * Binds Windows imports to physical journal4/6 and backup3 inputs.
 * Keeps the Unix/default factory's Windows refusal. Requires the caller's actual
 * selected-profile lock and quiesced source, backup and target writers. The native
 * receiver acquires separate leases and returns its measured durable receipt.
 * Does not authorize startup, profile activation, books or cache import.
 *
 * @param {MigrationJournal} journal - Actual open journal with original roots.
 * @param {nsIDatabaseCore} core - Actual started Panorama database.
 * @param {function(string): (nsIMsgFolder|Promise<nsIMsgFolder>)} resolveFolder -
 *   Resolves a retained source ID to its actual native folder.
 * @param {nsIProfileLock} profileLock - Caller-held lock through checkpointing.
 * @returns {object} Receipt lookup and import boundary for resumeMorkImports.
 * @throws {Error} For non-Windows, old progress or incomplete admission.
 */
export function createWindowsPanoramaMigrationTarget(
  journal,
  core,
  resolveFolder,
  profileLock
) {
  if (AppConstants.platform != "win") {
    throw new Error("Windows version2 migration requires Windows");
  }
  if (
    !(journal instanceof MigrationJournal) ||
    ![4, 6].includes(journal.state.version) ||
    !["import", "validate", "activate", "complete"].includes(
      journal.state.stage
    ) ||
    !journal.state.backup
  ) {
    throw new Error("Windows migration requires a backed-up version4 journal");
  }
  return bindPanoramaMigrationTarget(
    journal,
    core,
    resolveFolder,
    profileLock,
    true
  );
}

/**
 * @param {MigrationJournal} journal - Open retained plan.
 * @param {nsIDatabaseCore} core - Native backend.
 * @param {Function} resolveFolder - Actual original-folder resolver.
 * @param {nsIProfileLock} profileLock - Held selected-profile lock.
 * @param {boolean} windows - Explicit version2 admission, never a startup gate.
 * @param {?function(): nsIFile} [checkStartup=null] - Actual native startup owner check.
 * @returns {object} Checked native receipt/import methods.
 */
function bindPanoramaMigrationTarget(
  journal,
  core,
  resolveFolder,
  profileLock,
  windows,
  checkStartup = null
) {
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  if (
    typeof database.importFolderSnapshot != "function" ||
    typeof database.getFolderImportReceipt != "function" ||
    typeof resolveFolder != "function"
  ) {
    throw new Error(
      "Native version1 migration APIs and folder resolver are required"
    );
  }
  if (AppConstants.platform == "win" && !windows) {
    throw new Error(
      "Windows migration import requires native reparse admission"
    );
  }
  const lock = checkStartup
    ? null
    : profileLock.QueryInterface(Ci.nsIProfileLock);
  const databaseSourceId = database.sourceId;
  const checkIdentity = () => {
    if (
      !databaseSourceId ||
      database.sourceId !== databaseSourceId ||
      journal.state.sources.some(
        source => source.databaseSourceId !== databaseSourceId
      )
    ) {
      throw new Error(
        "Native migration database incarnation differs from the retained plan"
      );
    }
  };
  const checkLock = () => {
    if (checkStartup) {
      checkStartup();
      return;
    }
    const directory = lock.directory.clone();
    if (windows) {
      const state = journal.state;
      const root = state.originalRoots.find(
        item => item.canonicalPath === state.profilePath
      );
      if (!root) {
        throw new Error("Migration profile has no original admitted root");
      }
      const fs = Cc[
        "@mozilla.org/mailnews/panorama-migration-file-system;1"
      ].getService(Ci.nsIPanoramaMigrationFileSystem);
      const lease = fs.admit(
        directory,
        new FileUtils.File(root.originalPath),
        fs.KIND_DIRECTORY
      );
      try {
        fs.validate(lease);
        if (
          lease.canonicalPath !== state.profilePath ||
          lease.identity !== state.profilePhysicalIdentity.id ||
          lease.parentIdentity !== state.profilePhysicalIdentity.parentId ||
          lease.rootIdentity !== root.physicalIdentity.id
        ) {
          throw new Error("Migration profile lock selects another profile");
        }
      } finally {
        lease.close();
      }
      return;
    }
    if (directory.isSymlink()) {
      throw new Error("Migration profile lock directory is a link");
    }
    directory.normalize();
    if (!directory.equals(new FileUtils.File(journal.state.profilePath))) {
      throw new Error("Migration profile lock selects another profile");
    }
  };
  const plannedSource = (token, identity) => {
    checkIdentity();
    const source = journal.state.sources.find(
      item => item.id === identity.sourceId
    );
    if (
      !source ||
      source.token !== token ||
      source.sha256 !== identity.sourceSha256 ||
      source.destinationFolderId !== identity.destinationFolderId
    ) {
      throw new Error(
        "Native migration request differs from the journal source"
      );
    }
    return source;
  };
  const checkBackup = async () => {
    if (!windows) {
      return;
    }
    const state = journal.state;
    const actual = await verifyMigrationBackup(state.backupPath);
    const manifest = await IOUtils.readJSON(actual.path);
    if (
      actual.path !== state.backup.path ||
      actual.sha256 !== state.backup.sha256 ||
      manifest.version !== 3 ||
      JSON.stringify(manifest.originalRoots) !==
        JSON.stringify(state.originalRoots) ||
      (await hashMigrationFile(actual.path)) !== actual.sha256
    ) {
      throw new Error("Windows migration backup identity changed");
    }
  };
  const checkPaths = (folder, source, request) => {
    if (windows) {
      const measured = validateMorkFolderWindowsInventory(
        source.inventory,
        folder
      );
      if (
        source.path !== measured.summary.canonicalPath ||
        source.physicalIdentity?.version !== 1 ||
        source.physicalIdentity.id !== measured.summary.id ||
        source.physicalIdentity.parentId !== measured.summary.parentId ||
        Object.values(measured).some(
          record =>
            !journal.state.originalRoots.some(
              root =>
                root.originalPath === record.originalRoot &&
                root.canonicalPath === record.canonicalRoot &&
                root.physicalIdentity.id === record.rootId
            )
        ) ||
        (request &&
          (request.version !== 2 ||
            request.folder.summaryPath !== measured.summary.canonicalPath ||
            request.folder.storePath !== measured.store.canonicalPath))
      ) {
        throw new Error(
          "Mork snapshot conflicts with journal/database identity"
        );
      }
      return;
    }
    const roots = [journal.state.profilePath, ...journal.state.mailPaths].map(
      path => new FileUtils.File(path)
    );
    const summary = admittedFolderPath(folder.summaryFile, roots);
    const store = admittedFolderPath(folder.filePath, roots);
    if (
      summary !== source.path ||
      (request &&
        (summary !== request.folder.summaryPath ||
          store !== request.folder.storePath))
    ) {
      throw new Error("Mork snapshot conflicts with journal/database identity");
    }
  };
  const checkedReceipt = (folder, request, receipt) => {
    const result = validateMorkFolderReceipt(request, receipt);
    if (journal.state.stage == "import" || journal.state.version === 7) {
      verifyNativeMessageProjection(database, folder, request, result);
    }
    checkIdentity();
    checkLock();
    return result;
  };
  checkIdentity();
  checkLock();
  let prepared = null;
  return {
    async findProtocolUnitReceipt(token, ids) {
      prepared = null;
      checkIdentity();
      checkLock();
      const unit = journal.state.protocolUnits?.find(
        value => value.token === token
      );
      if (!unit || JSON.stringify(unit.sourceIds) !== JSON.stringify(ids)) {
        throw new Error(
          "Native protocol request differs from journal membership"
        );
      }
      await checkBackup();
      const entries = [];
      const members = [];
      for (const id of ids) {
        const source = journal.state.sources.find(value => value.id === id);
        if (
          !source ||
          source.protocol !== "imap" ||
          source.protocolUnitToken !== token
        ) {
          throw new Error("Native protocol source is not in its retained unit");
        }
        const folder = (await resolveFolder(id)).QueryInterface(
          Ci.nsIMsgFolder
        );
        checkIdentity();
        checkLock();
        checkPaths(folder, source);
        const input = await readMorkFolderImport(
          folder,
          source.token,
          windows ? source.inventory : undefined
        );
        checkIdentity();
        checkLock();
        checkPaths(folder, source, input);
        entries.push({
          input,
          source,
          folderFlags: database.folderDB.getFolderFlags(folder.id),
        });
        members.push({ folder, source });
      }
      const request = convertMorkProtocolUnit(entries, token, databaseSourceId);
      await journal.bindImportUnit(request);
      checkIdentity();
      checkLock();
      for (let index = 0; index < members.length; index++) {
        checkPaths(
          members[index].folder,
          members[index].source,
          request.folders[index]
        );
      }
      const receipt = database.getFolderImportReceipt(
        members[0].folder,
        request
      );
      checkIdentity();
      checkLock();
      if (receipt !== null) {
        const checked = validateMorkProtocolUnitReceipt(request, receipt);
        if (unit.state !== "imported" || journal.state.version === 7) {
          for (let index = 0; index < members.length; index++) {
            const { folder, source } = members[index];
            checkPaths(folder, source, request.folders[index]);
            verifyNativeMessageProjection(
              database,
              folder,
              request.folders[index],
              checked.folders[index]
            );
          }
        }
        // Only checkpointed receipts survive legitimate queue/header changes.
        return checked;
      }
      prepared = { unit: true, request, members };
      return null;
    },
    async importProtocolUnit(token, ids) {
      const pending = prepared;
      prepared = null;
      const unit = journal.state.protocolUnits?.find(
        value => value.token === token
      );
      if (
        !pending?.unit ||
        pending.request.token !== token ||
        !unit ||
        unit.state !== "importing" ||
        !unit.input ||
        JSON.stringify(unit.sourceIds) !== JSON.stringify(ids) ||
        pending.members.length !== ids.length
      ) {
        throw new Error("Native protocol import has no matching prepared unit");
      }
      checkIdentity();
      checkLock();
      await checkBackup();
      for (let index = 0; index < pending.members.length; index++) {
        const { folder } = pending.members[index];
        const source = journal.state.sources.find(
          value => value.id === ids[index]
        );
        if (
          !source ||
          source.state !== "importing" ||
          source.protocolUnitToken !== token
        ) {
          throw new Error("Native protocol import changed its journal source");
        }
        checkPaths(folder, source, pending.request.folders[index]);
      }
      const receipt = await database.importFolderSnapshot(
        pending.members[0].folder,
        pending.request
      );
      checkIdentity();
      checkLock();
      const checked = validateMorkProtocolUnitReceipt(pending.request, receipt);
      for (let index = 0; index < pending.members.length; index++) {
        const { folder, source } = pending.members[index];
        checkPaths(folder, source, pending.request.folders[index]);
        verifyNativeMessageProjection(
          database,
          folder,
          pending.request.folders[index],
          checked.folders[index]
        );
      }
      return checked;
    },
    async findReceipt(token, identity) {
      prepared = null;
      const source = plannedSource(token, identity);
      checkLock();
      await checkBackup();
      const folder = (await resolveFolder(source.id)).QueryInterface(
        Ci.nsIMsgFolder
      );
      checkPaths(folder, source);
      const request = convertMorkFolderSnapshot(
        await readMorkFolderImport(
          folder,
          token,
          windows ? source.inventory : undefined
        ),
        source,
        databaseSourceId,
        database.folderDB.getFolderFlags(folder.id)
      );
      checkPaths(folder, source, request);
      checkIdentity();
      checkLock();
      const receipt = database.getFolderImportReceipt(folder, request);
      checkIdentity();
      if (receipt !== null) {
        return checkedReceipt(folder, request, receipt);
      }
      prepared = { folder, request };
      return null;
    },
    async importFolder(input) {
      const pending = prepared;
      prepared = null;
      const source = plannedSource(input.token, {
        sourceId: input.sourceId,
        sourceSha256: input.source.sha256,
        destinationFolderId: input.destinationFolderId,
      });
      if (
        !pending ||
        source.state != "importing" ||
        pending.request.token !== input.token ||
        pending.request.sourceId !== input.sourceId ||
        pending.request.source.path !== input.source.path ||
        pending.request.source.sha256 !== input.source.sha256 ||
        pending.request.source.size !== input.source.size ||
        !sameKeys(pending.request.source.messageKeys, input.source.messageKeys)
      ) {
        throw new Error(
          "Native migration import has no matching prepared snapshot"
        );
      }
      checkLock();
      await checkBackup();
      checkPaths(pending.folder, source, pending.request);
      const receipt = await database.importFolderSnapshot(
        pending.folder,
        pending.request
      );
      checkIdentity();
      return checkedReceipt(pending.folder, pending.request, receipt);
    },
  };
}

/**
 * Reads the supported native message projection before an import checkpoint.
 * Uses only the complete committed physical-key map and actual folder. Every
 * public property name/value is checked, including derived body-field aliases.
 * Stored flags are checked independently of the facade NewList contribution.
 * Does not write, reimport, validate opaque structural storage or prove that a
 * body is available. Caller retains its profile lock and writer quiescence.
 *
 * @param {nsIDatabaseCore} database - Actual started native receiver.
 * @param {nsIMsgFolder} folder - Actual physically bound destination.
 * @param {object} request - Complete converted source snapshot.
 * @param {object} receipt - Validated complete native key map.
 * @returns {void}
 * @throws {Error} For any changed/missing/extra message, field or property.
 *   Native getter failures propagate unchanged after the already committed import.
 */
function verifyNativeMessageProjection(database, folder, request, receipt) {
  const keys = new Map(receipt.keys);
  const remaining = new Set(keys.values());
  const headers = new Map();
  for (const header of folder.messages) {
    if (!remaining.delete(header.messageKey)) {
      throw new Error("Native migration message set differs from its receipt");
    }
    headers.set(header.messageKey, header);
  }
  if (remaining.size) {
    throw new Error("Native migration message set differs from its receipt");
  }
  const newKeys = new Set(folder.msgDatabase.getNewList());
  const equal = (actual, expected, name) => {
    if (actual !== expected) {
      throw new Error("Native migration message projection differs: " + name);
    }
  };
  for (const message of request.messages) {
    const key = keys.get(message.sourceKey);
    const actual = headers.get(key);
    const expected = message.header;
    // Public flags include transient NewList status; the imported word must
    // still match exactly, including a persisted New bit added after import.
    const stored = database.messageDB.getSearchState(key);
    equal(stored?.flags, expected.flags, "stored flags");
    equal(actual.messageKey, key, "messageKey");
    equal(actual.folder.id, request.folder.id, "folder");
    for (const [name, value] of [
      ["messageId", expected.messageId],
      ["date", expected.date],
      ["author", expected.sender],
      ["recipients", expected.recipients],
      ["ccList", expected.ccList],
      ["bccList", expected.bccList],
      ["subject", expected.subject],
      [
        "flags",
        (expected.flags | (newKeys.has(key) ? Ci.nsMsgMessageFlags.New : 0)) >>>
          0,
      ],
      ["priority", expected.priority],
      ["charset", expected.charset],
      ["threadId", keys.get(message.rootSourceKey)],
      [
        "threadParent",
        message.parentSourceKey === null
          ? 0
          : keys.get(message.parentSourceKey),
      ],
    ]) {
      equal(actual[name], value, name);
    }
    equal(actual.numReferences, expected.references.length, "References count");
    expected.references.forEach((reference, ordinal) => {
      equal(
        actual.getStringReference(ordinal),
        reference,
        "References ordinal " + ordinal
      );
    });
    equal(
      actual.getUint32Property("dateReceived"),
      expected.dateReceived / 1000000,
      "dateReceived"
    );
    const properties = new Map(expected.extras.map(({ k, v }) => [k, v]));
    equal(
      actual.getStringProperty("keywords"),
      properties.get("keywords") ?? expected.keywords,
      "keywords"
    );
    properties.delete("keywords"); // Native tags are a field, not a property row.
    equal(
      actual.accountKey,
      properties.has("account")
        ? expected.accountKey
        : lazy.MailServices.accounts.findAccountForServer(folder.server).key,
      "accountKey"
    );
    for (const name of [
      "storeToken",
      "messageSize",
      "offlineMessageSize",
      "lineCount",
    ]) {
      if (Object.hasOwn(expected, name)) {
        equal(actual[name], expected[name], name);
        // These canonical getters are projections of the legacy body fields.
        // Original size/offlineMsgSize/numLines cells remain separate properties.
        properties.set(name, String(expected[name]));
      }
    }
    const uid = request.imap?.serverUids.find(
      binding => binding.sourceKey === message.sourceKey
    );
    if (uid) {
      // A classic source uses its old key as UID without a raw property cell.
      // The explicit native binding materializes the canonical hex property.
      equal(actual.getUint32Property("uidOnServer"), uid.uid, "uidOnServer");
      properties.set("uidOnServer", uid.uid.toString(16));
    }
    const present = new Set(actual.properties);
    if (
      present.size !== properties.size ||
      [...present].some(name => !properties.has(name))
    ) {
      throw new Error("Native migration message property presence differs");
    }
    for (const [name, value] of properties) {
      equal(
        database.messageDB.getMessageProperty(key, name),
        value,
        "property " + name
      );
    }
  }
}

/**
 * @param {number[]} left - Original keys.
 * @param {number[]} right - Planned keys.
 * @returns {boolean} Exact unique key-set equality, independent of row order.
 */
function sameKeys(left, right) {
  const keys = new Set(right);
  return (
    left.length == right.length &&
    keys.size == right.length &&
    new Set(left).size == left.length &&
    left.every(key => keys.has(key))
  );
}

/**
 * Resolves physical aliases above admitted roots, refusing links at/below them.
 * A missing leaf uses its existing parent; no source or store is created.
 *
 * @param {nsIFile} original - Actual native summary or body-store path.
 * @param {nsIFile[]} roots - Canonical profile and external-mail backup roots.
 * @returns {string} Canonical path contained by an admitted root.
 * @throws {Error} For links, paths outside the roots or filesystem errors.
 */
function admittedFolderPath(original, roots) {
  const file = original.clone();
  let resolved = null;
  let admittedRoot = null;
  for (let current = file; current; current = current.parent) {
    let missing = false;
    try {
      if (current.isSymlink()) {
        throw new Error("Migration folder path contains a link below its root");
      }
    } catch (error) {
      if (error.result != Cr.NS_ERROR_FILE_NOT_FOUND || current !== file) {
        throw error;
      }
      missing = true;
    }
    let canonical = current.clone();
    if (missing) {
      canonical = current.parent;
      canonical.normalize();
      canonical.append(current.leafName);
    } else {
      canonical.normalize();
    }
    if (!resolved) {
      resolved = canonical;
      for (const root of roots) {
        if (
          (root.equals(resolved) || root.contains(resolved)) &&
          (!admittedRoot || root.contains(admittedRoot))
        ) {
          admittedRoot = root;
        }
      }
      if (!admittedRoot) {
        throw new Error("Migration folder path is outside backed-up roots");
      }
    }
    if (canonical.equals(admittedRoot)) {
      return resolved.path;
    }
  }
  throw new Error("Migration folder path has no admitted ancestor");
}

/**
 * Binds mail imports to the genuine native startup operation.
 * Existing caller-held nsIProfileLock entry points keep their original meaning.
 *
 * @param {MigrationJournal} journal - Bound startup import journal.
 * @param {nsIDatabaseCore} core - Actual startup target.
 * @param {function(string): nsIMsgFolder} resolveFolder - Actual native folders.
 * @param {nsISupports} operation - Native-owned selected startup operation.
 * @returns {object} Existing receipt/import methods with native owner checks.
 */
export function createStartupPanoramaMigrationTarget(
  journal,
  core,
  resolveFolder,
  operation
) {
  return bindPanoramaMigrationTarget(
    journal,
    core,
    resolveFolder,
    null,
    false,
    () => startupMigrationDirectory(journal, core, operation)
  );
}

/**
 * Checks the native startup owner and exact journal/database incarnation.
 *
 * @param {MigrationJournal} journal - Retained bound journal.
 * @param {nsIDatabaseCore} core - Actual target service.
 * @param {nsISupports} operation - Live native startup operation.
 * @returns {nsIFile} Actual selected profile directory.
 */
function startupMigrationDirectory(journal, core, operation) {
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  const selected = database.validateProfileStartup(operation);
  if (
    AppConstants.platform === "win" ||
    selected.phase !== "target-open" ||
    selected.profilePath !== journal.state.profilePath ||
    !selected.databaseSourceId ||
    selected.databaseSourceId !== database.sourceId ||
    journal.state.sources.some(
      source => source.databaseSourceId !== selected.databaseSourceId
    )
  ) {
    throw new Error("Migration startup operation or target identity changed");
  }
  return new FileUtils.File(selected.profilePath);
}

/**
 * Starts the ordinary selected-profile operation from MailGlue app-startup.
 * Captures supported persisted input paths and copies legacy data synchronously
 * before the first await and later profile notifications. It does not pump the
 * event loop, reacquire XRE's lock or open AccountManager to discover sources.
 *
 * @param {AbortSignal} [signal] - Cancellation at settled IO boundaries.
 * @returns {Promise<object>} Native ready result, or the original recovery error.
 */
export function startPanoramaProfileAtStartup(signal) {
  const database = Cc["@mozilla.org/mailnews/database-core;1"].getService(
    Ci.nsIDatabaseCore
  );
  const pending = database.beginProfileStartup();
  let captured;
  let captureError;
  try {
    captured = captureStartupMigration(signal);
  } catch (error) {
    captureError = error;
  }
  return finishPanoramaProfileStartup(
    database,
    pending,
    captured,
    captureError,
    signal
  );
}

/**
 * Captures actual persisted input paths and a closed-writer startup backup.
 *
 * @param {AbortSignal} [signal] - Cancellation checked during the copy.
 * @returns {object} Selected root, native-file presence and optional copy inputs.
 * @throws {Error} For unsafe roots, unconfigured data or unsupported protocols.
 */
function captureStartupMigration(signal) {
  if (signal?.aborted) {
    throw new DOMException("Migration cancelled", "AbortError");
  }
  const profile = startupSourceFile(
    Services.dirsvc.get("ProfDS", Ci.nsIFile).path
  );
  const target = profile.clone();
  target.append("panorama.sqlite");
  const selector = profile.clone();
  selector.append("panorama-profile.json");
  const work = profile.parent.clone();
  work.append("panorama-migration-" + profile.leafName);
  const targetExists = startupEntryExists(target);
  const selectorExists = startupEntryExists(selector);
  if (startupEntryExists(work) && !selectorExists) {
    throw new Error("Existing migration work requires explicit recovery");
  }
  if (!targetExists) {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const auxiliary = profile.clone();
      auxiliary.append("panorama.sqlite" + suffix);
      if (startupEntryExists(auxiliary)) {
        throw new Error(
          "Orphan Panorama recovery file is not an absent database"
        );
      }
    }
  }
  if (
    !Services.prefs.getBoolPref("mail.panorama.enabled", false) ||
    targetExists ||
    selectorExists
  ) {
    return { profilePath: profile.path };
  }
  if (AppConstants.platform === "win") {
    throw new Error(
      "Windows startup migration requires native activation admission"
    );
  }
  const { collectMigrationRoots, createMigrationBackupAtStartup } =
    ChromeUtils.importESModule(
      "resource:///modules/panorama/MigrationBackup.sys.mjs"
    );
  const roots = collectMigrationRoots();
  if (roots.profilePath !== profile.path) {
    throw new Error("Startup inventory selects another profile");
  }
  for (const path of roots.mailPaths) {
    const directory = startupSourceFile(path);
    if (!profile.equals(directory) && !profile.contains(directory)) {
      throw new Error(
        "External mail root has no closed-writer startup ownership"
      );
    }
  }
  const servers = [];
  const branches = new Set();
  for (const name of Services.prefs.getChildList("mail.server.")) {
    const match = /^mail\.server\.([^.]+)\.directory(?:-rel)?$/.exec(name);
    if (match && match[1] !== "default") {
      branches.add(match[1]);
    }
  }
  for (const key of [...branches].sort()) {
    const branch = "mail.server." + key + ".";
    const directory = Services.prefs.prefHasUserValue(branch + "directory-rel")
      ? Services.prefs.getComplexValue(
          branch + "directory-rel",
          Ci.nsIRelativeFilePref
        ).file
      : Services.prefs.getComplexValue(branch + "directory", Ci.nsIFile);
    const root = startupSourceFile(directory.path);
    const protocol = Services.prefs.getCharPref(branch + "type");
    const contract = Services.prefs.getCharPref(
      branch + "storeContractID",
      "@mozilla.org/msgstore/berkeleystore;1"
    );
    const storeType = {
      "@mozilla.org/msgstore/berkeleystore;1": "mbox",
      "@mozilla.org/msgstore/maildirstore;1": "maildir",
    }[contract];
    if (
      !storeType ||
      !["none", "pop3", "imap", "rss", "nntp"].includes(protocol)
    ) {
      throw new Error(
        "Unsupported startup migration protocol or message store"
      );
    }
    servers.push({
      key,
      root: root.path,
      protocol,
      storeType,
      storeContractID: contract,
    });
  }
  const files = [];
  const visit = directory => {
    for (const entry of directory.directoryEntries) {
      const file = entry.QueryInterface(Ci.nsIFile);
      if (
        directory.equals(profile) &&
        ["parent.lock", ".parentlock", "lock"].includes(file.leafName)
      ) {
        continue;
      }
      if (file.isSymlink()) {
        throw new Error("Startup inventory contains a link");
      }
      if (file.isDirectory()) {
        visit(file);
      } else if (file.isFile()) {
        files.push(file.clone());
      } else {
        throw new Error("Startup inventory contains a nonregular file");
      }
    }
  };
  visit(profile);
  const summaries = [];
  const serverSummaries = [];
  const books = [];
  const caches = [];
  for (const file of files) {
    if (file.leafName.endsWith(".msf")) {
      const matches = servers.filter(server =>
        new FileUtils.File(server.root).contains(file)
      );
      const rootMatches = servers.filter(
        server =>
          server.protocol === "imap" && file.path === server.root + ".msf"
      );
      if (rootMatches.length === 1 && matches.length === 0) {
        const server = rootMatches[0];
        serverSummaries.push({
          id: "server-summary:" + file.getRelativePath(profile),
          role: "imap-server-root-summary",
          path: file.path,
          serverKey: server.key,
          serverRoot: server.root,
          protocol: server.protocol,
          storeContractID: server.storeContractID,
          storeType: server.storeType,
        });
        continue;
      }
      if (matches.length !== 1 || rootMatches.length) {
        throw new Error(
          "Mork summary has no unique persisted server root: " +
            file.path +
            " (matches " +
            matches.length +
            ")"
        );
      }
      const server = matches[0];
      if (!["none", "imap"].includes(server.protocol)) {
        throw new Error("Native Mork migration does not support this protocol");
      }
      summaries.push({
        id: "mail:" + file.getRelativePath(profile),
        path: file.path,
        storePath: file.path.slice(0, -4),
        serverKey: server.key,
        serverRoot: server.root,
        storeContractID: server.storeContractID,
        protocol: server.protocol,
        storeType: server.storeType,
        physicalRelativePath: file.getRelativePath(
          new FileUtils.File(server.root)
        ),
      });
    } else if (file.leafName.endsWith(".mab")) {
      books.push({
        id: "book:" + file.getRelativePath(profile),
        path: file.path,
      });
    } else if (
      file.parent.equals(profile) &&
      ["panacea.dat", "folderCache.json"].includes(file.leafName)
    ) {
      caches.push({
        id: "cache:" + file.getRelativePath(profile),
        path: file.path,
      });
    }
  }
  const activeJSON = caches.find(
    cache => PathUtils.filename(cache.path) === "folderCache.json"
  );
  if (activeJSON) {
    // Follow native legacy JSON precedence. The complete backup preserves an
    // obsolete Mork cache; its stale fields never override the active JSON.
    caches.splice(
      0,
      caches.length,
      ...(startupJSONCacheIsEmpty(activeJSON.path) ? [] : [activeJSON])
    );
  }
  for (const file of files) {
    const server = servers.find(item =>
      new FileUtils.File(item.root).contains(file)
    );
    if (!server || file.leafName.endsWith(".msf")) {
      continue;
    }
    if (
      [
        "msgFilterRules.dat",
        "popstate.dat",
        "feeds.json",
        "feeditems.json",
      ].includes(file.leafName)
    ) {
      continue;
    }
    const matched = summaries.some(
      source =>
        source.storePath === file.path ||
        (source.storeType === "maildir" &&
          new FileUtils.File(source.storePath).contains(file))
    );
    if (!matched) {
      throw new Error("Message-store data has no supported Mork summary");
    }
  }
  if (books.length) {
    const profiles = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    if (
      !profiles.currentProfile ||
      !profiles.currentProfile.rootDir.equals(profile)
    ) {
      throw new Error(
        "Address-book migration requires the actual named startup profile"
      );
    }
    const names = new Map();
    for (const pref of Services.prefs.getChildList("ldap_2.servers.")) {
      if (!pref.endsWith(".filename")) {
        continue;
      }
      const filename = Services.prefs.getStringPref(pref);
      const file = PathUtils.isAbsolute(filename)
        ? startupSourceFile(filename)
        : startupSourceFile(PathUtils.join(profile.path, filename));
      if (!profile.contains(file)) {
        throw new Error(
          "External address book has no closed-writer startup ownership"
        );
      }
      if (names.has(file.path)) {
        throw new Error(
          "Address book has ambiguous persisted directory identity"
        );
      }
      const description = pref.slice(0, -"filename".length) + "description";
      let name = Services.prefs.getStringPref(description, "");
      if (name.startsWith("chrome://")) {
        name = Services.prefs.getComplexValue(
          description,
          Ci.nsIPrefLocalizedString
        ).data;
      }
      if (!name || name.includes("\0")) {
        throw new Error("Address book has no supported persisted display name");
      }
      names.set(file.path, name);
    }
    for (const book of books) {
      if (!names.has(book.path)) {
        throw new Error("Mork address book has no unique persisted directory");
      }
      book.dirName = names.get(book.path);
    }
  }
  if (
    !summaries.length &&
    !serverSummaries.length &&
    !books.length &&
    !caches.length
  ) {
    return {
      profilePath: profile.path,
      servers,
      summaries,
      serverSummaries,
      books,
      caches,
    };
  }
  // The stable outside-profile path preserves discoverable failed attempts.
  // Never create another archive to conceal an existing journal/partial copy.
  work.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  const backupPath = PathUtils.join(work.path, "backup");
  const backup = createMigrationBackupAtStartup(
    profile.path,
    roots.mailPaths,
    backupPath,
    signal
  );
  return {
    profilePath: profile.path,
    servers,
    summaries,
    serverSummaries,
    books,
    caches,
    workPath: work.path,
    backupPath,
    backup,
  };
}

/**
 * Retains original native discovery inputs without deriving remote hierarchy
 * from body-store filenames. The native provider resolves URI and folder IDs.
 *
 * @param {object} source - Captured summary and persisted server/store identity.
 * @param {object} summary - Parsed original Mork summary, including raw rows.
 * @param {object[]} caches - Parsed caches with their original file identities.
 * @returns {object} Exact provider input, never native discovery authority.
 * @throws {Error} For absent, conflicting or unsupported retained IMAP metadata.
 */
function startupFolderOrigin(source, summary, caches) {
  if (source.protocol === "none") {
    return { provider: "local-store-discovery" };
  }
  if (source.protocol !== "imap") {
    throw new Error("No native startup discovery provider for this protocol");
  }
  // Use the same strict UTF-8 cache-key projection as the existing importer.
  // persistentDescriptor is an ACString byte sequence, not JavaScript text.
  const originalKey = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(
    MailStringUtils.byteStringToUint8Array(
      new FileUtils.File(source.path).persistentDescriptor
    )
  );
  const matches = caches.flatMap(({ identity, input }) => {
    const row = input.entries.get(originalKey);
    return row ? [{ identity, row, format: input.format }] : [];
  });
  if (matches.length !== 1) {
    throw new Error("IMAP summary has no unique original folder-cache entry");
  }
  const { identity, row, format } = matches[0];
  const { onlineName, hierDelim, boxFlags } = row.values;
  if (
    !["onlineName", "hierDelim", "boxFlags"].every(name =>
      row.properties.has(name)
    ) ||
    typeof onlineName !== "string" ||
    !onlineName ||
    onlineName.includes("\0") ||
    !Number.isInteger(hierDelim) ||
    hierDelim <= 0 ||
    hierDelim > 127 ||
    [94, 124].includes(hierDelim) ||
    !Number.isInteger(boxFlags) ||
    boxFlags < 0 ||
    boxFlags > 0xffffffff
  ) {
    // '^' and '|' are the native unknown/NIL sentinels, not real delimiters.
    throw new Error(
      "IMAP discovery requires retained name, delimiter and flags"
    );
  }
  const rows = [...summary.source.rows.values()].filter(
    item => item.scope === "ns:msg:db:row:scope:dbfolderinfo:all"
  );
  if (rows.length > 1) {
    throw new Error("IMAP summary has ambiguous folder metadata");
  }
  const raw = rows[0]?.cells.get("onlineName");
  if (raw !== undefined) {
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      MailStringUtils.byteStringToUint8Array(raw)
    );
    if (name !== onlineName) {
      throw new Error("IMAP summary and retained cache online names differ");
    }
  }
  return {
    provider: "imap-client-discovery",
    cache: {
      ...identity,
      originalKey,
      ...(format === "json"
        ? { sourceFormat: "json" }
        : { sourceKey: row.sourceKey }),
    },
    originalCells: Object.fromEntries(
      ["onlineName", "hierDelim", "boxFlags"].map(name => [
        name,
        row.properties.get(name),
      ])
    ),
    onlineName,
    hierarchyDelimiter: hierDelim,
    boxFlags,
  };
}

/**
 * Checks one startup leaf below the already validated selected profile/parent.
 *
 * @param {nsIFile} file - Selected target, selector, recovery or work entry.
 * @returns {boolean} Whether the native entry exists.
 * @throws {Error} For links or any error other than an actually missing leaf.
 */
function startupEntryExists(file) {
  try {
    if (file.isSymlink()) {
      throw new Error("Panorama startup input contains a link");
    }
  } catch (error) {
    if (error.result !== Cr.NS_ERROR_FILE_NOT_FOUND || file.exists()) {
      throw error;
    }
    return false;
  }
  return file.exists();
}

/**
 * Rejects aliased startup source paths without creating defaults.
 *
 * @param {string} path - Existing absolute source directory.
 * @returns {nsIFile} Canonical unlinked file.
 */
function startupSourceFile(path) {
  const file = new FileUtils.File(path);
  for (let part = file; part; part = part.parent) {
    if (part.isSymlink()) {
      throw new Error("Startup source path contains a link");
    }
  }
  file.normalize();
  return file;
}

/**
 * Completes the native selected-profile operation without releasing XRE's lock.
 *
 * @param {nsIDatabaseCore} database - Actual native service.
 * @param {Promise<nsISupports>} pending - Native app-startup admission.
 * @param {object} captured - Synchronous inventory and optional verified copy.
 * @param {Error} captureError - Original synchronous inventory/copy failure.
 * @param {AbortSignal} signal - Cancellation requested by the startup owner.
 * @returns {Promise<object>} Native ready identity.
 */
async function finishPanoramaProfileStartup(
  database,
  pending,
  captured,
  captureError,
  signal
) {
  const {
    getMigrationProfileState,
    prepareStartupMigrationProfile,
    activateStartupMigrationProfile,
    requireStartupProfileRecovery,
  } = ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationProfile.sys.mjs"
  );
  let operation;
  let journal;
  let createdSelection = false;
  try {
    operation = await pending;
    if (captureError) {
      throw captureError;
    }
    if (signal?.aborted) {
      throw new DOMException("Migration cancelled", "AbortError");
    }
    const selected = database.validateProfileStartup(operation);
    if (selected.profilePath !== captured.profilePath) {
      throw new Error("Native startup selects another profile");
    }
    const initial = await getMigrationProfileState(selected.profilePath);
    if (
      initial.record &&
      (initial.state !== "active" || initial.record.formatVersion !== 2)
    ) {
      throw new Error(
        "Existing migration selection requires explicit recovery"
      );
    }
    let origin;
    let target;
    if (selected.mode === "migrate") {
      if (!captured.backup) {
        throw new Error(
          "Legacy startup migration has no verified closed-writer copy"
        );
      }
      const books = [];
      for (const [index, book] of captured.books.entries()) {
        const { identity } = await readMorkAddressBookSource(book.path);
        books.push({
          ...book,
          ...identity,
          stagingPath: PathUtils.join(
            captured.workPath,
            "book-" + index + ".sqlite"
          ),
        });
        database.validateProfileStartup(operation);
      }
      const caches = [];
      const cacheInputs = [];
      for (const cache of captured.caches) {
        const { identity, cache: input } = await readStartupFolderCacheSource(
          cache.path
        );
        caches.push({
          ...cache,
          ...identity,
          cacheKeys: [...input.entries.keys()],
          ...(input.format === "json" ? { sourceFormat: "json" } : {}),
        });
        cacheInputs.push({ identity, input });
        database.validateProfileStartup(operation);
      }
      const serverSummaries = [];
      for (const source of captured.serverSummaries) {
        const { identity, summary } = await readMorkMigrationSource(
          source.path
        );
        const rows = [...summary.source.rows.values()];
        if (
          summary.messages.length ||
          rows.length !== 1 ||
          rows[0].scope !== "ns:msg:db:row:scope:dbfolderinfo:all"
        ) {
          throw new Error(
            "Unsupported data in native IMAP server-root summary"
          );
        }
        serverSummaries.push({ ...source, ...identity });
        database.validateProfileStartup(operation);
      }
      const sources = [];
      for (const source of captured.summaries) {
        const { identity, summary } = await readMorkMigrationSource(
          source.path
        );
        sources.push({
          ...source,
          ...identity,
          origin: startupFolderOrigin(source, summary, cacheInputs),
        });
        database.validateProfileStartup(operation);
      }
      const journalPath = PathUtils.join(captured.workPath, "journal.json");
      journal = await MigrationJournal.create(journalPath, {
        profilePath: selected.profilePath,
        mailPaths: [],
        backupPath: captured.backupPath,
        sources: [],
        ...(books.length ? { books } : {}),
        startupInventory: { sources, caches, serverSummaries },
      });
      journal.close();
      await prepareStartupMigrationProfile(
        selected.profilePath,
        journalPath,
        captured.backup
      );
      createdSelection = true;
      journal = await MigrationJournal.open(journalPath, selected.profilePath);
      target = database.openProfileStartupTarget(operation, {
        mode: "migrate",
        profilePath: selected.profilePath,
        journalPath,
        backup: captured.backup,
        sources,
        books,
        caches,
        serverSummaries,
      });
      await journal.bindStartupTarget(database, operation, target.folders);
      await journal.recordBackup(captured.backup);
      const folders = new Map(
        target.folders.map(binding => [binding.sourceId, binding.folder])
      );
      const resolveFolder = id => {
        startupMigrationDirectory(journal, database, operation);
        const folder = folders.get(id);
        if (!folder) {
          throw new Error("Startup import has no actual native folder binding");
        }
        return folder;
      };
      const bindings = caches.length
        ? startupCacheBindings(captured, database, folders)
        : new Map();
      const cacheBindings = new Map();
      for (const cache of caches) {
        const mapping = new Map(
          cache.cacheKeys.map(key => {
            const binding = bindings.get(key);
            if (!binding) {
              throw new Error(
                "Original cache key has no exact native folder binding"
              );
            }
            return [key, binding];
          })
        );
        const snapshot = await prepareMorkFolderCacheImport(
          journal,
          database,
          null,
          cache.path,
          mapping,
          2,
          operation
        );
        await journal.planCacheImport(cache.id, snapshot);
        cacheBindings.set(cache.id, mapping);
      }
      const native = createStartupPanoramaMigrationTarget(
        journal,
        database,
        resolveFolder,
        operation
      );
      await resumeMorkImports(journal, native, signal);
      if (books.length) {
        const profiles = Cc[
          "@mozilla.org/toolkit/profile-service;1"
        ].getService(Ci.nsIToolkitProfileService);
        if (!profiles.currentProfile) {
          throw new Error(
            "Address-book migration requires a named selected profile"
          );
        }
        startupMigrationDirectory(journal, database, operation);
        await resumeMorkBookImportsAndPublish(
          journal,
          profiles.currentProfile,
          new Map(books.map(book => [book.id, book.dirName])),
          signal
        );
        startupMigrationDirectory(journal, database, operation);
      }
      if (caches.length) {
        await resumeMorkCacheImports(
          journal,
          database,
          null,
          id => cacheBindings.get(id),
          signal,
          operation
        );
      }
      await validateStartupMigration(journal, native, database, operation);
      await journal.finishStage("validate");
      origin = "migrated";
    } else {
      if (!["reuse", "initialize"].includes(selected.mode)) {
        throw new Error("Unsupported native startup selection mode");
      }
      const mode = selected.mode;
      if (mode === "initialize" && captured.backup) {
        throw new Error("Native empty initialization omitted legacy inventory");
      }
      target = database.openProfileStartupTarget(operation, {
        mode,
        profilePath: selected.profilePath,
      });
      origin =
        initial.record?.origin ??
        (mode === "reuse" ? "adopted-existing" : "initialized-empty");
    }
    if (!initial.record || (origin === "migrated" && createdSelection)) {
      await activateStartupMigrationProfile(
        database,
        operation,
        origin,
        journal
      );
      createdSelection = true;
    } else if (
      initial.record.identity.databaseSourceId !== target.databaseSourceId ||
      initial.record.identity.schemaVersion !== target.schemaVersion
    ) {
      throw new Error(
        "Existing Panorama selection differs from its native target"
      );
    }
    await database.completeProfileStartup(operation, {
      profilePath: selected.profilePath,
      selectorPath: PathUtils.join(
        selected.profilePath,
        "panorama-profile.json"
      ),
      journalPath: journal
        ? PathUtils.join(captured.workPath, "journal.json")
        : (initial.record?.identity.journalPath ?? null),
    });
    return {
      profilePath: selected.profilePath,
      mode: selected.mode,
      databaseSourceId: target.databaseSourceId,
    };
  } catch (error) {
    if (journal) {
      try {
        await journal.recordError(error);
      } catch (secondary) {
        console.error(
          "Could not checkpoint startup migration error",
          secondary
        );
      }
    }
    if (createdSelection) {
      try {
        await requireStartupProfileRecovery(captured.profilePath);
      } catch (secondary) {
        console.error(
          "Could not persist startup recovery selection",
          secondary
        );
      }
    }
    journal?.close();
    if (operation) {
      try {
        await database.failProfileStartup(
          operation,
          error.result ?? Cr.NS_ERROR_FAILURE
        );
      } catch (secondary) {
        console.error("Could not settle failed native startup", secondary);
      }
    }
    throw error;
  } finally {
    journal?.close();
  }
}

/**
 * Binds cache keys only to their exact current physical native descriptors.
 * Ambiguous/moved keys are left unmapped so the existing complete-map check fails.
 *
 * @param {object} captured - Persisted native server-root inventory.
 * @param {nsIDatabaseCore} database - Actual started migration target.
 * @param {Map<string, nsIMsgFolder>} folders - Native summary-bound folders.
 * @returns {Map<string, object>} Exact physical cache-key/native-folder bindings.
 */
function startupCacheBindings(captured, database, folders) {
  const actual = [...folders.values()];
  for (const server of captured.servers) {
    const id = database.folderDB.getFolderByPath(server.key);
    if (id) {
      actual.push(database.folderDB.getMsgFolderForFolder(id));
    }
  }
  const result = new Map();
  for (const folder of actual) {
    const file = (
      folder.isServer ? folder.filePath : folder.summaryFile
    ).clone();
    file.normalize();
    const descriptor = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(
      MailStringUtils.byteStringToUint8Array(file.persistentDescriptor)
    );
    if (result.has(descriptor) && result.get(descriptor).folder !== folder) {
      throw new Error("Native cache descriptor is ambiguous");
    }
    result.set(descriptor, { folder, descriptor });
  }
  return result;
}

/**
 * Reads every committed native mail receipt again before activation.
 * Book/cache import paths already read back and validate their actual publication.
 *
 * @param {MigrationJournal} journal - Completely imported startup journal.
 * @param {object} native - Checked startup native receipt adapter.
 * @param {nsIDatabaseCore} database - Actual target.
 * @param {nsISupports} operation - Retained native startup operation.
 * @returns {Promise<void>} Full matching native mail receipt readback.
 */
async function validateStartupMigration(journal, native, database, operation) {
  if (journal.state.stage !== "validate" || journal.state.cancelled) {
    throw new Error("Startup migration imports have not completed");
  }
  for (const unit of journal.state.protocolUnits ?? []) {
    const receipt = await native.findProtocolUnitReceipt(
      unit.token,
      unit.sourceIds
    );
    if (JSON.stringify(receipt) !== JSON.stringify(unit.receipt)) {
      throw new Error("Native protocol receipt changed before activation");
    }
    startupMigrationDirectory(journal, database, operation);
  }
  for (const source of journal.state.sources) {
    if (source.protocol === "imap") {
      continue;
    }
    const receipt = await native.findReceipt(source.token, {
      sourceId: source.id,
      sourceSha256: source.sha256,
      destinationFolderId: source.destinationFolderId,
    });
    // The native adapter has checked the source/database identities. Unix
    // journals retain only this canonical four-field receipt projection.
    if (
      !receipt ||
      receipt.sourceId !== source.id ||
      receipt.databaseSourceId !== source.databaseSourceId ||
      receipt.token !== source.receipt.token ||
      receipt.sourceSha256 !== source.receipt.sourceSha256 ||
      receipt.folderId !== source.receipt.folderId ||
      JSON.stringify(receipt.keys.toSorted((a, b) => a[0] - b[0])) !==
        JSON.stringify(source.receipt.keys)
    ) {
      throw new Error("Native import receipt changed before activation");
    }
    startupMigrationDirectory(journal, database, operation);
  }
}
