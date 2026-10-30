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
  validateMorkFolderReceipt,
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
  createMorkFolderCacheRequest,
  getMorkFolderCacheCells,
  validateMorkFolderCacheReceipt,
} from "resource:///modules/panorama/MorkFolderCache.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
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
    for (const source of journal.state.sources) {
      await checkCancelled();
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
 * @returns {Promise<object>} Owned source bytes/raw records and exact folder
 *   bindings/properties. This is read-only input, never an import completion.
 * @throws {Error} For unsupported paths, changed identity or incomplete mapping.
 */
export async function prepareMorkFolderCacheImport(
  journal,
  core,
  profileLock,
  path,
  bindings
) {
  if (AppConstants.platform == "win") {
    throw new Error(
      "Windows cache migration requires native reparse admission"
    );
  }
  const database = core.QueryInterface(Ci.nsIDatabaseCore);
  const lock = profileLock.QueryInterface(Ci.nsIProfileLock);
  const state = journal.state;
  const databaseSourceId = database.sourceId;
  const roots = [state.profilePath, ...state.mailPaths].map(
    root => new FileUtils.File(root)
  );
  const checkTarget = () => {
    const current = journal.state;
    const selected = new FileUtils.File(PathUtils.profileDir);
    const directory = lock.directory.clone();
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
      !current.sources.length ||
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
  const { cache, bytes, identity } = await readMorkFolderCacheSource(canonical);
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
  checkTarget();
  if (
    admittedFolderPath(original, roots) !== identity.path ||
    (await IOUtils.computeHexDigest(identity.path, "sha256")) !==
      identity.sha256 ||
    (await IOUtils.computeHexDigest(backup.path, "sha256")) !== backup.sha256
  ) {
    throw new Error("Migration cache input changed during preparation");
  }
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
    folders: folders.map(folder => {
      const entry = cache.entries.get(folder.originalKey);
      return {
        ...folder,
        sourceKey: entry.sourceKey,
        properties: [...entry.properties].map(([name, text]) => ({
          name,
          text,
          ...(typeof entry.values[name] == "number"
            ? { integer: entry.values[name] }
            : {}),
        })),
      };
    }),
  };
}

/**
 * Applies supported cache cells through native SQL receipts, then checkpoints.
 * The caller retains the selected profile lock and quiesces source/target writers.
 * Native-authoritative flags/counts/sizes/display remain provenance, not overrides.
 *
 * @param {MigrationJournal} journal - Explicit version5 cache plan.
 * @param {nsIDatabaseCore} core - Actual native cache receiver.
 * @param {nsIProfileLock} profileLock - Held selected profile lock.
 * @param {function(string): Map<string, object>} resolveBindings - Exact original-key bindings.
 * @param {AbortSignal} [signal] - Cancellation at settled commit boundaries.
 * @returns {Promise<void>} Supported cache units checkpointed; no activation.
 */
export async function resumeMorkCacheImports(
  journal,
  core,
  profileLock,
  resolveBindings,
  signal
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
      const snapshot = await prepareMorkFolderCacheImport(
        journal,
        database,
        profileLock,
        cache.path,
        await resolveBindings(cache.id)
      );
      const current = {
        ...cache,
        ...snapshot.source,
        folders: snapshot.folders,
        databaseSourceId: snapshot.databaseSourceId,
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
      const directory = profileLock
        .QueryInterface(Ci.nsIProfileLock)
        .directory.clone();
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
  if (AppConstants.platform == "win") {
    throw new Error("Windows Gloda recovery requires native reparse admission");
  }
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
  const lock = profileLock.QueryInterface(Ci.nsIProfileLock);
  const databaseSourceId = database.sourceId;
  const before = JSON.stringify(state);
  const check = () => {
    const selected = new FileUtils.File(PathUtils.profileDir);
    const directory = lock.directory.clone();
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
    if (
      database.sourceId !== databaseSourceId ||
      JSON.stringify(journal.state) !== before
    ) {
      throw new Error("Gloda recovery journal/database identity changed");
    }
  };
  check();
  const backupPath = PathUtils.parent(state.backup.path);
  const backup = await verifyMigrationBackup(backupPath);
  if (
    backup.path !== state.backup.path ||
    backup.sha256 !== state.backup.sha256
  ) {
    throw new Error("Gloda recovery backup identity changed");
  }
  const sourcePath = admittedFolderPath(new FileUtils.File(path), [
    new FileUtils.File(PathUtils.parent(backup.path)),
  ]);
  const manifest = await IOUtils.readJSON(backup.path);
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
  if (
    snapshot.source.size !== entry.size ||
    snapshot.source.sha256 !== entry.sha256
  ) {
    throw new Error("Gloda recovery snapshot differs from the complete backup");
  }
  const folders = new Map();
  for (const source of state.sources) {
    folders.set(
      source.id,
      (await resolveFolder(source.id)).QueryInterface(Ci.nsIMsgFolder)
    );
  }
  const target = createPanoramaMigrationTarget(
    journal,
    database,
    id => folders.get(id),
    lock
  );
  const bindings = [];
  const receipts = new Map();
  for (const source of state.sources) {
    const receipt = await target.findReceipt(source.token, {
      sourceId: source.id,
      sourceSha256: source.sha256,
      destinationFolderId: source.destinationFolderId,
    });
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
      throw new Error("Native Gloda mail receipt differs from its checkpoint");
    }
    receipts.set(source.id, receipt);
    bindings.push({
      folderURI: folders.get(source.id).URI,
      source,
      originalSummary: await readMorkMigrationSource(source.path),
    });
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
 * Binds explicit Windows version2 imports to retained journal4/backup3 inputs.
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
    journal.state.version !== 4 ||
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
 * @returns {object} Checked native receipt/import methods.
 */
function bindPanoramaMigrationTarget(
  journal,
  core,
  resolveFolder,
  profileLock,
  windows
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
  const lock = profileLock.QueryInterface(Ci.nsIProfileLock);
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
  checkIdentity();
  checkLock();
  let prepared = null;
  return {
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
        return validateMorkFolderReceipt(request, receipt);
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
      return validateMorkFolderReceipt(pending.request, receipt);
    },
  };
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
