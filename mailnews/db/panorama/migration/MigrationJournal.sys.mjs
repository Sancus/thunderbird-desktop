/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";
import {
  verifyMigrationBackup,
  captureWindowsMigrationRoots,
} from "resource:///modules/panorama/MigrationBackup.sys.mjs";
import {
  LOCAL_STORE_PROTOCOLS,
  MIGRATED_MAIL_PROTOCOLS,
  validateMorkFolderWindowsInventory,
  validateMorkFolderWindowsReceipt,
} from "resource:///modules/panorama/MorkFolderImport.sys.mjs";

import {
  admitWindowsMigrationPath,
  hashMigrationFile,
  migrationPhysicalIdentity,
  isMigrationPhysicalIdentity,
  originalPathIdentity,
} from "resource:///modules/panorama/MigrationSource.sys.mjs";

import {
  createMorkFolderCacheRequest,
  getMorkFolderCacheCells,
  validateMorkFolderCacheReceipt,
} from "resource:///modules/panorama/MorkFolderCache.sys.mjs";

import {
  getMorkProtocolUnitIntent,
  validateMorkProtocolUnitReceipt,
} from "resource:///modules/panorama/MorkSnapshotAdapter.sys.mjs";

const STARTUP_VERSION = 7;
const PROTOCOL_VERSION = 6;
const CACHE_VERSION = 5;
const PHYSICAL_VERSION = 4;
const MAIL_VERSION = 1;
const BOOK_VERSION = 2;
const STAGES = ["backup", "import", "validate", "activate", "complete"];
const openJournals = new Set();

/**
 * Persists migration progress separately from the database transaction.
 * The caller must hold the profile lock and stop profile/mail-store writes.
 * After a failed write, close and reopen before reconciling database receipts.
 */
export class MigrationJournal {
  #path;
  #state;
  #busy = false;
  #failed = false;
  #closed = false;

  /**
   * Creates a journal outside the source trees. Existing files are not replaced.
   *
   * @param {string} path - Absolute journal path in a private work directory.
   * @param {{profilePath: string, backupPath: string, mailPaths: string[],
   *   sources: object[], books?: object[],
   *   startupInventory?: {sources: object[], caches: object[],
   *   serverSummaries?: object[]}}} plan - Mail sources retain version1
   *   fields. Books have id, path, sha256, size, cardKeys, listKeys and stagingPath.
   *   Each stage is a fresh .sqlite child of the private journal directory.
   *   Windows version4 requires original roots and each mail source.inventory (version2),
   *   plus actual source/profile/work physical IDs. Older Windows progress is refused.
   * @returns {Promise<MigrationJournal>} Open journal at the backup stage.
   */
  static async create(path, plan) {
    const journal = new MigrationJournal(path);
    try {
      if (plan.caches !== undefined) {
        throw new Error("Cache units require explicit planning after backup");
      }
      if (plan.books !== undefined && !Array.isArray(plan.books)) {
        throw new Error("Invalid migration book plan");
      }
      const originalRoots =
        AppConstants.platform == "win"
          ? captureWindowsMigrationRoots([plan.profilePath, ...plan.mailPaths])
          : null;
      let version = MAIL_VERSION;
      if (AppConstants.platform == "win") {
        version = PHYSICAL_VERSION;
      } else if (plan.books?.length) {
        version = BOOK_VERSION;
      }
      if (plan.sources.some(source => source.protocol === "imap")) {
        version = PROTOCOL_VERSION;
      }
      if (plan.startupInventory !== undefined) {
        // Windows startup journals remain physical: original roots, profile,
        // work, book and later bound source/cache file IDs are all retained.
        if (plan.sources.length) {
          throw new Error("Startup planning requires unbound sources");
        }
        version = STARTUP_VERSION;
      }
      const state = {
        ...([PROTOCOL_VERSION, STARTUP_VERSION].includes(version)
          ? { protocolUnits: [] }
          : {}),
        ...(version === STARTUP_VERSION
          ? {
              startup: {
                inventory: structuredClone(plan.startupInventory),
                bound: false,
                databaseSourceId: null,
              },
            }
          : {}),
        ...(originalRoots ? { originalRoots } : {}),
        version,
        profilePath: normalizedPath(plan.profilePath),
        backupPath: normalizedPath(plan.backupPath),
        mailPaths: plan.mailPaths.map(normalizedPath),
        backup: null,
        stage: "backup",
        cancelled: false,
        revision: 0,
        sources: plan.sources.map(source => ({
          ...source,
          path: normalizedPath(source.path),
          ...(originalRoots
            ? { inventory: structuredClone(source.inventory) }
            : {}),
          token: Services.uuid.generateUUID().toString(),
          state: "pending",
          receipt: null,
        })),
        lastError: null,
      };
      if (plan.books?.length) {
        state.books = plan.books.map(book => ({
          ...book,
          path: normalizedPath(book.path),
          stagingPath: normalizedPath(book.stagingPath),
          token: Services.uuid.generateUUID().toString(),
          state: "pending",
          receipt: null,
        }));
      }
      if (isPhysicalJournal(state)) {
        state.profilePhysicalIdentity = physicalIdentity(
          state.profilePath,
          true
        );
        state.workPhysicalIdentity = physicalIdentity(
          new FileUtils.File(journal.#path).parent.path,
          true
        );
        for (const source of [
          ...state.sources,
          ...(state.books ?? []),
          ...(state.caches ?? []),
        ]) {
          const actual = physicalIdentity(source.path);
          if (
            source.physicalIdentity &&
            !samePhysical(source.physicalIdentity, actual)
          ) {
            throw new Error("Migration source physical identity changed");
          }
          source.physicalIdentity = actual;
        }
      }
      journal.#validate(state);
      const lease = journal.#workLease(state);
      try {
        await IOUtils.writeJSON(journal.#path, state, {
          mode: "create",
          flush: true,
        });
      } finally {
        lease?.close();
      }
      journal.#state = state;
      return journal;
    } catch (error) {
      journal.close();
      throw error;
    }
  }

  /**
   * Opens existing progress. Corrupt or newer versions are never recreated.
   *
   * @param {string} path - Absolute journal path.
   * @param {string} profilePath - Expected original profile path.
   * @returns {Promise<MigrationJournal>} Validated persisted progress.
   */
  static async open(path, profilePath) {
    const journal = new MigrationJournal(path);
    let lease;
    try {
      lease =
        AppConstants.platform == "win"
          ? admitWindowsMigrationPath(
              new FileUtils.File(journal.#path),
              Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
            )
          : null;
      if (new FileUtils.File(journal.#path).isSymlink()) {
        throw new Error("Migration journal must not be a symlink");
      }
      if ((await IOUtils.stat(journal.#path)).type != "regular") {
        throw new Error("Migration journal is not a regular file");
      }
      const state = await IOUtils.readJSON(journal.#path);
      journal.#validate(state);
      if (
        !new FileUtils.File(state.profilePath).equals(
          new FileUtils.File(normalizedPath(profilePath))
        )
      ) {
        throw new Error("Migration journal belongs to another profile");
      }
      if (state.stage != "backup") {
        await journal.#checkBackup(state, state.backup);
      }
      journal.#state = state;
      return journal;
    } catch (error) {
      journal.close();
      throw error;
    } finally {
      lease?.close();
    }
  }

  /** @param {string} path - Absolute journal path; use create or open. */
  constructor(path) {
    if (!PathUtils.isAbsolute(path)) {
      throw new Error("Migration journal path must be absolute");
    }
    const file = new FileUtils.File(normalizedPath(path));
    this.#path = file.path;
    if (
      [...openJournals].some(other => file.equals(new FileUtils.File(other)))
    ) {
      throw new Error("Migration journal is already open");
    }
    openJournals.add(this.#path);
  }

  /** @returns {object} Owned copy; callers cannot change persisted progress. */
  get state() {
    return structuredClone(this.#state);
  }

  /** Releases this in-process writer. The caller retains the profile lock. */
  close() {
    if (this.#closed) {
      return;
    }
    if (this.#busy) {
      throw new Error("Migration journal write is in progress");
    }
    this.#closed = true;
    openJournals.delete(this.#path);
  }

  /**
   * Records a verified complete backup before importing anything.
   *
   * @param {{path: string, sha256: string}} backup - Verified backup manifest.
   * @returns {Promise<void>}
   */
  async recordBackup(backup) {
    await this.#change(async state => {
      await this.#checkBackup(state, backup);
      if (state.stage != "backup") {
        if (JSON.stringify(state.backup) != JSON.stringify(backup)) {
          throw new Error("Migration backup identity changed");
        }
        return false;
      }
      if (
        backup.path != PathUtils.join(state.backupPath, "manifest.json") ||
        !isDigest(backup.sha256)
      ) {
        throw new Error("Invalid migration backup receipt");
      }
      state.backup = structuredClone(backup);
      state.stage = "import";
      return true;
    });
  }

  /**
   * Persists a stable operation token before asking core to import a folder.
   * Repeated calls return the same token, including after interruption.
   *
   * @param {string} id - Physical source folder ID in the original plan.
   * @returns {Promise<string>} Token to store in core's import transaction.
   */
  async beginImport(id) {
    let token;
    await this.#change(async state => {
      const source = this.#source(state, id);
      if (source.protocol === "imap") {
        throw new Error("IMAP sources require a complete protocol import unit");
      }
      await this.#checkSource(source);
      token = source.token;
      if (source.state == "imported") {
        return false;
      }
      this.#requireActive(state, "import");
      if (source.state != "pending") {
        return false;
      }
      source.state = "importing";
      return true;
    });
    return token;
  }

  /**
   * Records core's committed receipt, including restart reconciliation.
   * Core must write this receipt and the imported rows in the same transaction.
   * Key pairs are stored in original-key order; allocation order is irrelevant.
   *
   * @param {string} id - Physical source folder ID.
   * @param {{token: string, sourceSha256: string, folderId: number,
   *   keys: number[][]}} receipt - Exact committed old-key/new-key mapping.
   *   Windows version4 additionally requires the complete native version2
   *   admission, retained source/database IDs and matching sourcePhysicalIdentity.
   * @returns {Promise<void>}
   */
  async recordImport(id, receipt) {
    await this.#change(state => {
      const source = this.#source(state, id);
      if (source.protocol === "imap") {
        throw new Error(
          "IMAP receipts require a complete protocol import unit"
        );
      }
      this.#validateReceipt(source, receipt);
      const normalized = this.#normalizeReceipt(source, receipt);
      if (source.state == "imported") {
        if (JSON.stringify(source.receipt) != JSON.stringify(normalized)) {
          throw new Error("Committed migration receipt changed");
        }
        return false;
      }
      if (state.stage != "import" || source.state != "importing") {
        throw new Error("Migration import was not started");
      }
      source.receipt = normalized;
      source.state = "imported";
      return true;
    });
  }

  /**
   * Starts every source in a retained IMAP unit in one durable journal change.
   * Uses a distinct unit token derived from canonical source-ID order on retry.
   *
   * @param {string[]} ids - Complete connected source set.
   * @returns {Promise<string>} Stable unit token, never a new retry identity.
   * @throws {Error} For overlapping units, changed membership or invalid sources.
   */
  async beginImportUnit(ids) {
    let token;
    await this.#change(async state => {
      const sources = this.#protocolSources(state, ids);
      for (const source of sources) {
        await this.#checkSource(source);
      }
      token = "imap-unit:" + sources[0].token;
      const existing = state.protocolUnits.find(unit => unit.token === token);
      const sourceIds = sources.map(source => source.id);
      if (existing) {
        if (JSON.stringify(existing.sourceIds) !== JSON.stringify(sourceIds)) {
          throw new Error("Migration protocol unit membership changed");
        }
        return false;
      }
      this.#requireActive(state, "import");
      if (
        sources.some(
          source => source.state !== "pending" || source.protocolUnitToken
        ) ||
        state.protocolUnits.some(unit =>
          unit.sourceIds.some(id => sourceIds.includes(id))
        )
      ) {
        throw new Error("Migration protocol unit overlaps existing work");
      }
      state.protocolUnits.push({
        token,
        sourceIds,
        state: "importing",
        input: null,
        receipt: null,
      });
      for (const source of sources) {
        source.state = "importing";
        source.protocolUnitToken = token;
      }
      return true;
    });
    return token;
  }

  /**
   * Persists the checked unit's typed intent before native import or receipt lookup.
   * Rebinding an existing token to different source/UID/counterpart data refuses.
   *
   * @param {object} request - Complete converted version3 source unit.
   * @returns {Promise<void>}
   * @throws {Error} For a changed or unstarted unit.
   */
  async bindImportUnit(request) {
    const input = getMorkProtocolUnitIntent(request);
    await this.#change(state => {
      const unit = state.protocolUnits?.find(
        value => value.token === input.token
      );
      if (!unit) {
        throw new Error("Migration protocol import unit was not started");
      }
      this.#checkProtocolInput(state, unit, input);
      if (unit.input) {
        if (JSON.stringify(unit.input) !== JSON.stringify(input)) {
          throw new Error("Migration protocol input changed after intent");
        }
        return false;
      }
      this.#requireActive(state, "import");
      if (unit.state !== "importing") {
        throw new Error("Migration protocol import intent is already settled");
      }
      unit.input = input;
      return true;
    });
  }

  /**
   * Checkpoints the complete native protocol receipt and every member together.
   * A cancellation after native commit does not hide the committed mapping.
   *
   * @param {string} token - Retained whole-unit token.
   * @param {object} receipt - Actual committed native version3 unit receipt.
   * @returns {Promise<void>}
   * @throws {Error} For a missing, changed or incomplete receipt.
   */
  async recordImportUnit(token, receipt) {
    await this.#change(state => {
      const unit = state.protocolUnits?.find(value => value.token === token);
      if (!unit?.input) {
        throw new Error(
          "Migration protocol import has no durable input intent"
        );
      }
      const normalized = validateMorkProtocolUnitReceipt(unit.input, receipt);
      if (unit.state === "imported") {
        if (JSON.stringify(unit.receipt) !== JSON.stringify(normalized)) {
          throw new Error("Committed migration protocol receipt changed");
        }
        return false;
      }
      if (state.stage !== "import" || unit.state !== "importing") {
        throw new Error("Migration protocol import was not started");
      }
      const sources = this.#protocolSources(state, unit.sourceIds);
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        if (
          source.state !== "importing" ||
          source.protocolUnitToken !== token
        ) {
          throw new Error(
            "Migration protocol source is not in its retained unit"
          );
        }
        this.#validateReceipt(source, normalized.folders[index]);
      }
      for (let index = 0; index < sources.length; index++) {
        sources[index].receipt = this.#normalizeReceipt(
          sources[index],
          normalized.folders[index]
        );
        sources[index].state = "imported";
      }
      unit.receipt = normalized;
      unit.state = "imported";
      return true;
    });
  }

  /**
   * @param {object} state - Owned journal state.
   * @param {string[]} ids - Complete retained source IDs.
   * @returns {object[]} Sources in canonical source-ID order.
   */
  #protocolSources(state, ids) {
    if (
      ![PROTOCOL_VERSION, STARTUP_VERSION].includes(state.version) ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some(id => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    ) {
      throw new Error("Invalid migration protocol source membership");
    }
    return [...ids].sort().map(id => {
      const source = this.#source(state, id);
      if (source.protocol !== "imap") {
        throw new Error("Migration protocol unit contains a non-IMAP source");
      }
      return source;
    });
  }

  /**
   * @param {object} state - Current journal state.
   * @param {object} unit - Retained unit membership.
   * @param {object} input - Checked protocol intent.
   * @returns {void}
   */
  #checkProtocolInput(state, unit, input) {
    const sources = this.#protocolSources(state, unit.sourceIds);
    if (
      input.version !== 3 ||
      input.protocol !== "imap" ||
      input.token !== unit.token ||
      input.folders.length !== sources.length
    ) {
      throw new Error("Migration protocol intent differs from its source unit");
    }
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const member = input.folders[index];
      if (
        member.sourceId !== source.id ||
        member.token !== source.token ||
        member.databaseSourceId !== source.databaseSourceId ||
        member.databaseSourceId !== input.databaseSourceId ||
        member.folder.protocol !== "imap" ||
        member.folder.id !== source.destinationFolderId ||
        member.source.path !== source.path ||
        member.source.sha256 !== source.sha256 ||
        member.source.size !== source.size ||
        JSON.stringify([...member.source.messageKeys].sort((a, b) => a - b)) !==
          JSON.stringify([...source.messageKeys].sort((a, b) => a - b)) ||
        member.imap?.version !== 1 ||
        (source.originalFolderURI !== undefined &&
          member.imap.originalFolderURI !== source.originalFolderURI) ||
        (source.inventory &&
          JSON.stringify(member.windowsAdmission) !==
            JSON.stringify(source.inventory.windowsAdmission))
      ) {
        throw new Error("Migration protocol intent changed a retained source");
      }
    }
  }

  /**
   * @param {object} source - Retained individual source.
   * @param {object} receipt - Checked native member receipt.
   * @returns {object} Existing canonical per-source receipt representation.
   */
  #normalizeReceipt(source, receipt) {
    return {
      token: receipt.token,
      sourceSha256: receipt.sourceSha256,
      folderId: receipt.folderId,
      keys: receipt.keys.map(pair => [...pair]).sort((a, b) => a[0] - b[0]),
      ...(source.inventory
        ? {
            version: 2,
            sourceId: receipt.sourceId,
            databaseSourceId: receipt.databaseSourceId,
            windowsAdmission: structuredClone(receipt.windowsAdmission),
          }
        : {}),
      ...(source.physicalIdentity
        ? {
            sourcePhysicalIdentity: structuredClone(
              receipt.sourcePhysicalIdentity
            ),
          }
        : {}),
    };
  }

  /**
   * Records a stable public book identity before importing or publishing it.
   * The caller retains the actual selected profile lock. A retry keeps its
   * original UID and exact selected display name without rewriting the intent.
   *
   * @param {string} id - Original planned book identity.
   * @param {string} dirName - Exact selected display name.
   * @returns {Promise<{bookUID: string, dirName: string}>} Durable intent.
   * @throws {Error} On cancelled work, changed source/name or journal failure.
   */
  async beginBookPublication(id, dirName) {
    let intent;
    await this.#change(async state => {
      if (
        state.cancelled ||
        !["import", "validate"].includes(state.stage) ||
        typeof dirName != "string" ||
        dirName.includes("\0")
      ) {
        throw new Error("Book publication is cancelled or has an invalid name");
      }
      const book = this.#book(state, id);
      await this.#checkSource(book);
      await this.#checkBackup(state, state.backup);
      if (book.publication) {
        if (book.publication.dirName !== dirName) {
          throw new Error("Book publication name changed");
        }
        intent = {
          bookUID: book.publication.bookUID,
          dirName,
        };
        return false;
      }
      intent = {
        bookUID: Services.uuid.generateUUID().toString().slice(1, -1),
        dirName,
      };
      book.publication = { ...intent, state: "pending", receipt: null };
      return true;
    });
    return intent;
  }

  /**
   * Checkpoints an actual durable Manager publication before cancellation.
   * A failed journal write leaves the Manager's real commit available for the
   * same-identity retry. Live objects and the transient reused flag are omitted.
   *
   * @param {string} id - Original planned book identity.
   * @param {object} receipt - Actual Manager result and scoped card/list maps.
   * @returns {Promise<void>} Persisted public identity or unchanged exact retry.
   * @throws {Error} On a conflicting result, incomplete import or write failure.
   */
  async recordBookPublication(id, receipt) {
    await this.#change(state => {
      const book = this.#book(state, id);
      if (
        !["import", "validate"].includes(state.stage) ||
        book.state != "imported" ||
        !book.publication
      ) {
        throw new Error("Book publication has no settled import and intent");
      }
      const normalized = this.#bookPublicationReceipt(book, receipt);
      if (book.publication.state == "published") {
        if (
          JSON.stringify(book.publication.receipt) != JSON.stringify(normalized)
        ) {
          throw new Error("Committed book publication changed");
        }
        return false;
      }
      book.publication.state = "published";
      book.publication.receipt = normalized;
      return true;
    });
  }

  /**
   * Persists a book operation before creating its staged database.
   * The token is the opaque sourceId stored by SQLiteDirectory, not a card UID.
   *
   * @param {string} id - Original book identity in the plan.
   * @returns {Promise<string>} Retained storage operation identity.
   */
  async beginBookImport(id) {
    let token;
    await this.#change(async state => {
      const book = this.#book(state, id);
      await this.#checkSource(book);
      token = book.token;
      if (book.state == "imported") {
        return false;
      }
      this.#requireActive(state, "import");
      if (book.state != "pending") {
        return false;
      }
      book.state = "importing";
      return true;
    });
    return token;
  }

  /**
   * Checkpoints a committed whole-book receipt separately from mail key maps.
   * A storage commit can precede this write; restart reconciles the same token.
   * Cancellation does not prevent settling an already committed receipt.
   *
   * @param {string} id - Original book identity.
   * @param {object} receipt - Token, original sourceId, storageSourceId, source
   *   hash/size, stagingPath and scoped cards/lists [sourceKey, UID] arrays.
   *   Windows version4 also requires sourcePhysicalIdentity and stagePhysicalIdentity.
   * @returns {Promise<void>}
   */
  async recordBookImport(id, receipt) {
    await this.#change(state => {
      const book = this.#book(state, id);
      this.#validateBookReceipt(book, receipt, state);
      const normalized = {
        token: receipt.token,
        sourceId: receipt.sourceId,
        storageSourceId: receipt.storageSourceId,
        sourceSha256: receipt.sourceSha256,
        sourceSize: receipt.sourceSize,
        stagingPath: receipt.stagingPath,
        cards: receipt.cards.map(pair => [...pair]).sort((a, b) => a[0] - b[0]),
        lists: receipt.lists.map(pair => [...pair]).sort((a, b) => a[0] - b[0]),
        ...(book.physicalIdentity
          ? {
              sourcePhysicalIdentity: structuredClone(
                receipt.sourcePhysicalIdentity
              ),
              stagePhysicalIdentity: structuredClone(
                receipt.stagePhysicalIdentity
              ),
            }
          : {}),
      };
      if (book.state == "imported") {
        if (JSON.stringify(book.receipt) != JSON.stringify(normalized)) {
          throw new Error("Committed book receipt changed");
        }
        return false;
      }
      if (state.stage != "import" || book.state != "importing") {
        throw new Error("Book import was not started");
      }
      book.receipt = normalized;
      book.state = "imported";
      return true;
    });
  }

  /**
   * Explicitly adds a backed-up cache unit, preserving existing mail/book work.
   * Older journals are upgraded only by this call, never while opening them.
   *
   * @param {string} id - Original cache source ID.
   * @param {object} snapshot - Complete prepareMorkFolderCacheImport result.
   * @returns {Promise<string>} Durable native operation token.
   */
  async planCacheImport(id, snapshot) {
    if (
      ![1, 2, 3].includes(
        snapshot.requestVersion === undefined ? 1 : snapshot.requestVersion
      )
    ) {
      throw new Error("Unsupported native cache request version");
    }
    if ((snapshot.requestVersion ?? 1) === 1 && snapshot.proof !== undefined) {
      throw new Error("Cache proof requires version2");
    }
    let token;
    const cache = structuredClone({
      id,
      databaseSourceId: snapshot.databaseSourceId,
      ...snapshot.source,
      folders: snapshot.folders,
      ...(snapshot.requestVersion >= 2
        ? { requestVersion: snapshot.requestVersion, proof: snapshot.proof }
        : {}),
      ...(snapshot.requestVersion === 3
        ? { sourceFormat: snapshot.sourceFormat }
        : {}),
      ...(snapshot.unboundKeys?.length
        ? { unboundKeys: snapshot.unboundKeys }
        : {}),
      token: Services.uuid.generateUUID().toString(),
      state: "pending",
      receipt: null,
    });
    createMorkFolderCacheRequest(cache);
    getMorkFolderCacheCells(cache.folders);
    await this.#change(async state => {
      // Only the native selected-startup journal binds cache units on Windows;
      // its #checkSource re-admits the cache file and compares its file ID.
      if (AppConstants.platform == "win" && state.version !== STARTUP_VERSION) {
        throw new Error(
          "Windows cache migration requires native reparse admission"
        );
      }
      const previous = state.caches?.find(item => item.id === id);
      if (previous) {
        const planned = createMorkFolderCacheRequest({
          ...cache,
          token: previous.token,
        });
        const saved = createMorkFolderCacheRequest(previous);
        const sorted = folders => folders.toSorted((a, b) => a.id - b.id);
        if (
          JSON.stringify({ ...planned, folders: sorted(planned.folders) }) !==
            JSON.stringify({ ...saved, folders: sorted(saved.folders) }) ||
          JSON.stringify(getMorkFolderCacheCells(cache.folders)) !==
            JSON.stringify(getMorkFolderCacheCells(previous.folders))
        ) {
          throw new Error("Cache import plan changed");
        }
        token = previous.token;
        return false;
      }
      this.#requireActive(state, "import");
      state.version = [PROTOCOL_VERSION, STARTUP_VERSION].includes(
        state.version
      )
        ? state.version
        : CACHE_VERSION;
      (state.caches ??= []).push(cache);
      await this.#checkSource(cache);
      await this.#checkBackup(state, state.backup);
      token = cache.token;
      return true;
    });
    return token;
  }

  /** @param {string} id - Planned cache ID. @returns {Promise<string>} Retained token. */
  async beginCacheImport(id) {
    let token;
    await this.#change(async state => {
      const cache = this.#cache(state, id);
      await this.#checkSource(cache);
      token = cache.token;
      if (cache.state == "imported") {
        return false;
      }
      this.#requireActive(state, "import");
      if (cache.state != "pending") {
        return false;
      }
      cache.state = "importing";
      return true;
    });
    return token;
  }

  /**
   * Settles the actual native cache commit before cancellation or later work.
   *
   * @param {string} id - Planned cache ID.
   * @param {object} receipt - Native receipt with complete raw cell dispositions.
   * @returns {Promise<void>}
   */
  async recordCacheImport(id, receipt) {
    await this.#change(state => {
      const cache = this.#cache(state, id);
      const checked = validateMorkFolderCacheReceipt(cache, receipt);
      if (cache.state == "imported") {
        if (JSON.stringify(cache.receipt) !== JSON.stringify(checked)) {
          throw new Error("Committed cache receipt changed");
        }
        return false;
      }
      if (state.stage != "import" || cache.state != "importing") {
        throw new Error("Cache import was not started");
      }
      cache.receipt = checked;
      cache.state = "imported";
      return true;
    });
  }

  /**
   * Advances one fixed stage after its owner has completed the work.
   * Activation remains the caller's responsibility, outside any SQL transaction.
   *
   * @param {string} stage - import, validate or activate.
   * @returns {Promise<void>}
   */
  async finishStage(stage) {
    await this.#change(state => {
      this.#requireActive(state, stage);
      if (
        stage == "import" &&
        [
          ...state.sources,
          ...(state.books ?? []),
          ...(state.caches ?? []),
        ].some(source => source.state != "imported")
      ) {
        throw new Error("Migration imports are incomplete");
      }
      if (
        stage != "import" &&
        state.version !== STARTUP_VERSION &&
        (state.books?.length || state.caches?.length)
      ) {
        throw new Error(
          "Book/cache publication and activation are not supported"
        );
      }
      if (!["import", "validate", "activate"].includes(stage)) {
        throw new Error("Invalid migration stage transition");
      }
      if (state.version === STARTUP_VERSION && stage !== "import") {
        this.#requireStartupReadiness(state);
      }
      state.stage = STAGES[STAGES.indexOf(stage) + 1];
      return true;
    });
  }

  /**
   * Binds retained startup inputs to actual native folders after target creation.
   * No destination ID or database incarnation is invented before this point.
   *
   * @param {nsIDatabaseCore} core - Actual selected startup target.
   * @param {nsISupports} operation - Live native startup operation.
   * @param {{sourceId: string, folderId: number, folder: nsIMsgFolder}[]} bindings -
   *   Actual native message-folder bindings. Native server-root IDs come from
   *   the same validated operation and are retained separately in the journal.
   * @returns {Promise<void>} Durable native target binding before backup advance.
   * @throws {Error} For changed inventory, foreign folders or rebinding.
   */
  async bindStartupTarget(core, operation, bindings) {
    const database = core.QueryInterface(Ci.nsIDatabaseCore);
    const selected = database.validateProfileStartup(operation);
    if (
      selected.phase !== "target-open" ||
      !selected.databaseSourceId ||
      database.sourceId !== selected.databaseSourceId ||
      !Array.isArray(bindings)
    ) {
      throw new Error("Startup journal requires the actual native target");
    }
    const serverBindings =
      selected.serverSummaries === undefined ? [] : selected.serverSummaries;
    if (!Array.isArray(serverBindings)) {
      throw new Error(
        "Startup target has invalid native server-summary bindings"
      );
    }
    const folders = new Map();
    for (const binding of bindings) {
      const folder = binding.folder.QueryInterface(Ci.nsIMsgFolder);
      if (
        folders.has(binding.sourceId) ||
        folder.id !== binding.folderId ||
        !Number.isSafeInteger(folder.id) ||
        folder.id <= 0
      ) {
        throw new Error("Invalid startup native folder binding");
      }
      folders.set(binding.sourceId, folder);
    }
    await this.#change(state => {
      if (
        state.version !== STARTUP_VERSION ||
        state.stage !== "backup" ||
        state.cancelled ||
        state.profilePath !== selected.profilePath ||
        state.startup.bound ||
        folders.size !== state.startup.inventory.sources.length
      ) {
        throw new Error("Startup journal cannot change its target binding");
      }
      state.sources = state.startup.inventory.sources.map(source => {
        const folder = folders.get(source.id);
        if (
          !folder ||
          folder.server.key !== source.serverKey ||
          !folder.server.localPath.equals(
            new FileUtils.File(source.serverRoot)
          ) ||
          !folder.summaryFile.equals(new FileUtils.File(source.path)) ||
          !folder.filePath.equals(new FileUtils.File(source.storePath)) ||
          (source.folderURI !== undefined && folder.URI !== source.folderURI)
        ) {
          throw new Error("Startup native folder differs from retained source");
        }
        if (source.protocol === "imap") {
          const imapFolder = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
          if (
            imapFolder.onlineName !== source.origin.onlineName ||
            imapFolder.hierarchyDelimiter.charCodeAt(0) !==
              source.origin.hierarchyDelimiter
          ) {
            throw new Error("Native IMAP discovery changed retained identity");
          }
        }
        return {
          ...source,
          destinationFolderId: folder.id,
          folderURI: folder.URI,
          ...(source.protocol === "imap"
            ? { originalFolderURI: folder.URI }
            : {}),
          databaseSourceId: selected.databaseSourceId,
          token: Services.uuid.generateUUID().toString(),
          state: "pending",
          receipt: null,
        };
      });
      const summaries = state.startup.inventory.serverSummaries ?? [];
      if (serverBindings.length !== summaries.length) {
        throw new Error("Startup target omitted a native server-root binding");
      }
      const rootIds = new Set();
      state.startup.serverSummaries = serverBindings.map((binding, index) => {
        if (
          binding.sourceId !== summaries[index].id ||
          !Number.isSafeInteger(binding.folderId) ||
          binding.folderId <= 0 ||
          rootIds.has(binding.folderId) ||
          state.sources.some(
            source => source.destinationFolderId === binding.folderId
          )
        ) {
          throw new Error("Invalid startup native server-root binding");
        }
        rootIds.add(binding.folderId);
        return { sourceId: binding.sourceId, folderId: binding.folderId };
      });
      state.startup.bound = true;
      state.startup.databaseSourceId = selected.databaseSourceId;
      return true;
    });
    database.validateProfileStartup(operation);
  }

  /**
   * Persists cancellation or permits an explicit resume. Settling an already
   * committed import receipt remains allowed while cancellation is requested.
   *
   * @param {boolean} cancelled - Stop before starting more work.
   * @returns {Promise<void>}
   */
  async setCancelled(cancelled) {
    await this.#change(state => {
      if (typeof cancelled != "boolean") {
        throw new TypeError("Expected a cancellation boolean");
      }
      state.cancelled = cancelled;
      return true;
    });
  }

  /**
   * Persists an error without discarding stage progress or committed mappings.
   *
   * @param {Error} error - Original operation error.
   * @returns {Promise<void>}
   */
  async recordError(error) {
    await this.#change(state => {
      state.lastError = {
        name: typeof error?.name == "string" ? error.name : "Error",
        message:
          typeof error?.message == "string" ? error.message : String(error),
      };
      return true;
    });
  }

  async #change(update) {
    if (this.#closed || this.#failed || this.#busy) {
      throw new Error("Migration journal is closed, failed or busy");
    }
    this.#busy = true;
    try {
      const next = structuredClone(this.#state);
      if (!(await update(next))) {
        return;
      }
      next.revision++;
      this.#validate(next);
      let lease;
      try {
        lease = this.#workLease(next);
        if (lease) {
          normalizedPath(this.#path);
          normalizedPath(this.#path + ".tmp");
        }
        await IOUtils.writeJSON(this.#path, next, {
          tmpPath: this.#path + ".tmp",
          flush: true,
        });
      } catch (error) {
        this.#failed = true;
        throw error;
      } finally {
        lease?.close();
      }
      this.#state = next;
    } finally {
      this.#busy = false;
    }
  }

  async #checkSource(source) {
    if (source.inventory) {
      validateMorkFolderWindowsInventory(source.inventory);
    }
    const lease =
      AppConstants.platform == "win"
        ? admitWindowsMigrationPath(
            new FileUtils.File(source.path),
            Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
          )
        : null;
    try {
      const file = new FileUtils.File(source.path);
      const roots = [this.#state.profilePath, ...this.#state.mailPaths].map(
        path => new FileUtils.File(path)
      );
      for (let current = file; current; current = current.parent) {
        if (current.isSymlink()) {
          throw new Error("Migration source contains a link");
        }
        if (roots.some(root => root.equals(current))) {
          break;
        }
      }
      if (
        lease &&
        !samePhysical(migrationPhysicalIdentity(lease), source.physicalIdentity)
      ) {
        throw new Error("Migration source physical identity changed");
      }
      const before = await IOUtils.stat(source.path);
      if (before.type != "regular" || before.size != source.size) {
        throw new Error("Migration source changed since backup");
      }
      const hash = await hashMigrationFile(source.path);
      const after = await IOUtils.stat(source.path);
      if (
        before.type != "regular" ||
        before.size != source.size ||
        hash != source.sha256 ||
        before.size != after.size ||
        before.lastModified != after.lastModified
      ) {
        throw new Error("Migration source changed since backup");
      }
      if (lease) {
        migrationPhysicalIdentity(lease);
      }
    } finally {
      lease?.close();
    }
  }

  async #checkBackup(state, expected) {
    const actual = await verifyMigrationBackup(state.backupPath);
    if (actual.path != expected?.path || actual.sha256 != expected.sha256) {
      throw new Error("Migration backup identity changed");
    }
    const manifest = await IOUtils.readJSON(actual.path);
    if (
      isPhysicalJournal(state) &&
      (manifest.version !== 3 ||
        JSON.stringify(manifest.originalRoots) !==
          JSON.stringify(state.originalRoots))
    ) {
      throw new Error(
        "Migration requires backup3 with unchanged original roots"
      );
    }
    if (
      !new FileUtils.File(manifest.roots[0].source).equals(
        new FileUtils.File(state.profilePath)
      )
    ) {
      throw new Error("Migration backup belongs to another profile");
    }
    if (
      isPhysicalJournal(state) &&
      !samePhysical(
        manifest.roots[0].physicalIdentity,
        state.profilePhysicalIdentity
      )
    ) {
      throw new Error("Migration backup profile physical identity changed");
    }
    for (const path of [state.profilePath, ...state.mailPaths]) {
      const source = new FileUtils.File(path);
      if (
        !manifest.roots.some(root => {
          const saved = new FileUtils.File(root.source);
          return saved.equals(source) || saved.contains(source);
        })
      ) {
        throw new Error("Migration backup omits configured mail storage");
      }
    }
    const files = new Map();
    const filesByPath = new Map();
    const directoriesByPath = new Map();
    for (const root of manifest.roots) {
      for (const entry of root.entries) {
        if (entry.type == "directory") {
          const directory = new FileUtils.File(
            PathUtils.join(root.source, ...entry.parts)
          );
          directoriesByPath.set(directory.path, entry.physicalIdentity);
        }
        if (entry.type == "regular") {
          const matches = files.get(entry.sha256) ?? [];
          const saved = {
            file: new FileUtils.File(
              PathUtils.join(root.source, ...entry.parts)
            ),
            size: entry.size,
            physicalIdentity: entry.physicalIdentity,
            sha256: entry.sha256,
          };
          matches.push(saved);
          filesByPath.set(saved.file.path, saved);
          files.set(entry.sha256, matches);
        }
      }
    }
    for (const source of [
      ...state.sources,
      ...(state.books ?? []),
      ...(state.caches ?? []),
    ]) {
      if (source.inventory) {
        const measured = validateMorkFolderWindowsInventory(source.inventory);
        const stored = filesByPath.get(measured.store.canonicalPath);
        const directory = directoriesByPath.get(measured.store.canonicalPath);
        let differs;
        if (!measured.store.id) {
          differs = !!stored || !!directory;
        } else if (directory) {
          // A maildir store is a directory: its identity and every backed-up
          // message file below it must be unchanged.
          const root = new FileUtils.File(measured.store.canonicalPath);
          differs =
            directory.id !== measured.store.id ||
            directory.parentId !== measured.store.parentId;
          for (const saved of filesByPath.values()) {
            if (differs) {
              break;
            }
            if (root.contains(saved.file)) {
              differs =
                (await IOUtils.stat(saved.file.path)).size !== saved.size ||
                (await hashMigrationFile(saved.file.path)) !== saved.sha256;
            }
          }
        } else {
          differs =
            !stored ||
            stored.physicalIdentity.id !== measured.store.id ||
            stored.physicalIdentity.parentId !== measured.store.parentId ||
            (await IOUtils.stat(measured.store.canonicalPath)).size !==
              stored.size ||
            (await hashMigrationFile(measured.store.canonicalPath)) !==
              stored.sha256;
        }
        if (differs) {
          throw new Error("Migration body store differs from verified backup");
        }
      }
      if (
        !(files.get(source.sha256) ?? []).some(
          entry =>
            entry.size == source.size &&
            entry.file.equals(new FileUtils.File(source.path)) &&
            (!source.physicalIdentity ||
              samePhysical(entry.physicalIdentity, source.physicalIdentity))
        )
      ) {
        throw new Error(
          "Migration source is not covered by the verified backup"
        );
      }
    }
    if (actual.sha256 != (await hashMigrationFile(actual.path))) {
      throw new Error(
        "Migration backup changed while binding source identities"
      );
    }
  }

  #source(state, id) {
    const source = state.sources.find(item => item.id == id);
    if (!source) {
      throw new Error("Unknown migration source");
    }
    return source;
  }

  #workLease(state) {
    if (!isPhysicalJournal(state)) {
      return null;
    }
    const lease = admitWindowsMigrationPath(
      new FileUtils.File(this.#path).parent,
      Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
    );
    try {
      if (
        !samePhysical(
          migrationPhysicalIdentity(lease),
          state.workPhysicalIdentity
        )
      ) {
        throw new Error("Migration work directory physical identity changed");
      }
      return lease;
    } catch (error) {
      lease.close();
      throw error;
    }
  }

  #cache(state, id) {
    const cache = state.caches?.find(item => item.id === id);
    if (!cache) {
      throw new Error("Unknown migration cache");
    }
    return cache;
  }

  #book(state, id) {
    const book = state.books?.find(item => item.id == id);
    if (!book) {
      throw new Error("Unknown migration book");
    }
    return book;
  }

  #validateBookReceipt(book, receipt, state) {
    if (
      book.physicalIdentity &&
      (!samePhysical(receipt?.sourcePhysicalIdentity, book.physicalIdentity) ||
        !isMigrationPhysicalIdentity(receipt?.stagePhysicalIdentity) ||
        receipt.stagePhysicalIdentity.parentId !==
          state.workPhysicalIdentity.id ||
        !samePhysical(
          physicalIdentity(book.stagingPath, false, true),
          receipt.stagePhysicalIdentity
        ))
    ) {
      throw new Error("Book import physical identity changed");
    }
    if (
      receipt?.token != book.token ||
      receipt.sourceId != book.id ||
      receipt.storageSourceId != book.token ||
      receipt.sourceSha256 != book.sha256 ||
      receipt.sourceSize != book.size ||
      receipt.stagingPath != book.stagingPath
    ) {
      throw new Error("Invalid book import receipt");
    }
    const uids = new Set();
    for (const [kind, keys] of [
      ["cards", book.cardKeys],
      ["lists", book.listKeys],
    ]) {
      const pairs = receipt[kind];
      const remaining = new Set(keys);
      if (!Array.isArray(pairs) || pairs.length != keys.length) {
        throw new Error("Book UID mapping is incomplete");
      }
      for (const pair of pairs) {
        if (
          !Array.isArray(pair) ||
          pair.length != 2 ||
          !remaining.delete(pair[0]) ||
          typeof pair[1] != "string" ||
          !pair[1] ||
          pair[1].includes("/") ||
          pair[1].includes("\0") ||
          uids.has(pair[1])
        ) {
          throw new Error("Invalid book UID mapping");
        }
        uids.add(pair[1]);
      }
    }
  }

  /**
   * Normalizes the Manager identity while keeping the imported scoped maps.
   *
   * @param {object} book - Imported book with its durable publication intent.
   * @param {object} receipt - Actual Manager result or stored normalized result.
   * @returns {object} Stable serializable publication fields.
   * @throws {Error} On any changed source, UID map or destination association.
   */
  #bookPublicationReceipt(book, receipt) {
    const match = /^ldap_2\.servers\.panorama_import_([0-9a-f]{64})$/.exec(
      receipt?.dirPrefId
    );
    if (
      !match ||
      receipt.fileName !== `panorama-import-${match[1]}.sqlite` ||
      receipt.uri !== `jsaddrbook://${receipt.fileName}` ||
      receipt.bookUID !== book.publication.bookUID ||
      receipt.sourceId !== book.id ||
      receipt.storageSourceId !== book.token ||
      receipt.sourceSha256 !== book.sha256 ||
      receipt.sourceSize !== book.size ||
      !["cards", "lists"].every(kind => Array.isArray(receipt[kind]))
    ) {
      throw new Error("Invalid book publication receipt");
    }
    const result = {
      dirPrefId: receipt.dirPrefId,
      uri: receipt.uri,
      fileName: receipt.fileName,
      bookUID: receipt.bookUID,
      sourceId: receipt.sourceId,
      storageSourceId: receipt.storageSourceId,
      sourceSha256: receipt.sourceSha256,
      sourceSize: receipt.sourceSize,
      cards: receipt.cards.map(pair => [...pair]).sort((a, b) => a[0] - b[0]),
      lists: receipt.lists.map(pair => [...pair]).sort((a, b) => a[0] - b[0]),
    };
    for (const kind of ["cards", "lists"]) {
      if (JSON.stringify(result[kind]) !== JSON.stringify(book.receipt[kind])) {
        throw new Error("Book publication UID mapping changed");
      }
    }
    return result;
  }

  /**
   * Validates the optional publication state without advancing global activation.
   *
   * @param {object} book - Current planned book and existing import receipt.
   * @throws {Error} On an invalid intent or a publication without its import.
   */
  #validateBookPublication(book) {
    const publication = book.publication;
    if (publication === undefined) {
      return;
    }
    if (
      !publication ||
      !["pending", "published"].includes(publication.state) ||
      typeof publication.bookUID != "string" ||
      !publication.bookUID ||
      /[\0/\\]/u.test(publication.bookUID) ||
      typeof publication.dirName != "string" ||
      publication.dirName.includes("\0")
    ) {
      throw new Error("Invalid book publication intent");
    }
    if (publication.state == "pending") {
      if (publication.receipt !== null) {
        throw new Error("Uncommitted book publication has a receipt");
      }
    } else if (
      book.state != "imported" ||
      JSON.stringify(
        this.#bookPublicationReceipt(book, publication.receipt)
      ) !== JSON.stringify(publication.receipt)
    ) {
      throw new Error("Invalid committed book publication");
    }
  }

  #requireActive(state, stage) {
    if (state.cancelled || state.stage != stage) {
      throw new Error("Migration is cancelled or at another stage");
    }
  }

  #validateReceipt(source, receipt) {
    if (
      source.physicalIdentity &&
      !samePhysical(receipt?.sourcePhysicalIdentity, source.physicalIdentity)
    ) {
      throw new Error("Mail import physical identity is missing or changed");
    }
    if (source.inventory) {
      validateMorkFolderWindowsReceipt(source.inventory, receipt);
      if (
        receipt.sourceId !== source.id ||
        receipt.databaseSourceId !== source.databaseSourceId
      ) {
        throw new Error(
          "Native migration receipt source/database identity changed"
        );
      }
    }
    if (
      receipt?.token != source.token ||
      receipt.sourceSha256 != source.sha256 ||
      !Number.isSafeInteger(receipt.folderId) ||
      receipt.folderId <= 0 ||
      receipt.folderId != source.destinationFolderId ||
      !Array.isArray(receipt.keys)
    ) {
      throw new Error("Invalid migration import receipt");
    }
    if (receipt.keys.length != source.messageKeys.length) {
      throw new Error("Migration key mapping is incomplete");
    }
    const expectedKeys = new Set(source.messageKeys);
    const oldKeys = new Set();
    const newKeys = new Set();
    for (const pair of receipt.keys) {
      if (
        !Array.isArray(pair) ||
        pair.length != 2 ||
        !isKey(pair[0], true) ||
        !isKey(pair[1], false) ||
        !expectedKeys.has(pair[0]) ||
        oldKeys.has(pair[0]) ||
        newKeys.has(pair[1])
      ) {
        throw new Error("Invalid migration key mapping");
      }
      oldKeys.add(pair[0]);
      newKeys.add(pair[1]);
    }
  }

  /**
   * @param {object} state - State to validate before persistence or after reopen.
   * @returns {void}
   */
  #validateProtocolUnits(state) {
    if (![PROTOCOL_VERSION, STARTUP_VERSION].includes(state.version)) {
      if (
        "protocolUnits" in state ||
        state.sources.some(
          source => source.protocol === "imap" || "protocolUnitToken" in source
        )
      ) {
        throw new Error("Protocol migration requires its version6 journal");
      }
      return;
    }
    if (
      !Array.isArray(state.protocolUnits) ||
      (!state.sources.some(source => source.protocol === "imap") &&
        (state.version === PROTOCOL_VERSION || state.protocolUnits.length))
    ) {
      throw new Error("Invalid migration protocol journal");
    }
    const tokens = new Set();
    const members = new Set();
    for (const unit of state.protocolUnits) {
      const sources = this.#protocolSources(state, unit.sourceIds);
      if (
        unit.token !== "imap-unit:" + sources[0].token ||
        state.sources.some(source => source.token === unit.token) ||
        tokens.has(unit.token) ||
        !["importing", "imported"].includes(unit.state) ||
        JSON.stringify(unit.sourceIds) !==
          JSON.stringify(sources.map(source => source.id))
      ) {
        throw new Error("Invalid retained migration protocol unit");
      }
      tokens.add(unit.token);
      for (const source of sources) {
        if (
          members.has(source.id) ||
          source.state !== unit.state ||
          source.protocolUnitToken !== unit.token
        ) {
          throw new Error("Conflicting migration protocol membership/state");
        }
        members.add(source.id);
      }
      if (unit.input !== null) {
        this.#checkProtocolInput(
          state,
          unit,
          getMorkProtocolUnitIntent(unit.input)
        );
      }
      if (unit.state === "imported") {
        if (
          !unit.input ||
          JSON.stringify(
            validateMorkProtocolUnitReceipt(unit.input, unit.receipt)
          ) !== JSON.stringify(unit.receipt)
        ) {
          throw new Error("Invalid committed migration protocol receipt");
        }
        for (let index = 0; index < sources.length; index++) {
          if (
            JSON.stringify(sources[index].receipt) !==
            JSON.stringify(
              this.#normalizeReceipt(
                sources[index],
                unit.receipt.folders[index]
              )
            )
          ) {
            throw new Error(
              "Protocol member receipt differs from its committed unit"
            );
          }
        }
      } else if (unit.receipt !== null) {
        throw new Error("Uncommitted migration protocol unit has a receipt");
      }
    }
    for (const source of state.sources) {
      if (
        ("protocolUnitToken" in source ||
          (source.protocol === "imap" && source.state !== "pending")) &&
        !members.has(source.id)
      ) {
        throw new Error("Migration protocol source lost its complete unit");
      }
    }
  }

  /** @param {object} state - Retained startup plan and native bindings. */
  #validateStartup(state) {
    if (state.version !== STARTUP_VERSION) {
      if (state.startup !== undefined) {
        throw new Error("Startup plan requires its version7 journal");
      }
      return;
    }
    const startup = state.startup;
    if (
      !startup ||
      typeof startup.bound !== "boolean" ||
      !Array.isArray(startup.inventory?.sources) ||
      !Array.isArray(startup.inventory?.caches)
    ) {
      throw new Error("Invalid startup migration inventory");
    }
    const serverSummaries =
      startup.inventory.serverSummaries === undefined
        ? []
        : startup.inventory.serverSummaries;
    if (!Array.isArray(serverSummaries)) {
      throw new Error("Invalid startup server-summary inventory");
    }
    const ids = new Set();
    const paths = new Set();
    for (const input of [
      ...startup.inventory.sources,
      ...startup.inventory.caches,
      ...serverSummaries,
    ]) {
      if (
        typeof input.id !== "string" ||
        !input.id ||
        ids.has(input.id) ||
        !PathUtils.isAbsolute(input.path) ||
        normalizedPath(input.path) !== input.path ||
        paths.has(input.path) ||
        !isDigest(input.sha256) ||
        !Number.isSafeInteger(input.size) ||
        input.size < 0
      ) {
        throw new Error("Invalid retained startup source identity");
      }
      ids.add(input.id);
      paths.add(input.path);
    }
    for (const source of startup.inventory.sources) {
      validateStartupFolderOrigin(source, startup.inventory.caches);
    }
    const servers = new Set();
    for (const source of serverSummaries) {
      if (
        !MIGRATED_MAIL_PROTOCOLS.includes(source.protocol) ||
        source.role !==
          (source.protocol === "imap"
            ? "imap-server-root-summary"
            : "server-root-summary") ||
        source.size <= 0 ||
        source.size >= 0xffffffff ||
        typeof source.serverKey !== "string" ||
        !source.serverKey ||
        /[.\0]/.test(source.serverKey) ||
        servers.has(source.serverKey) ||
        !PathUtils.isAbsolute(source.serverRoot) ||
        normalizedPath(source.serverRoot) !== source.serverRoot ||
        !new FileUtils.File(state.profilePath).contains(
          new FileUtils.File(source.serverRoot)
        ) ||
        source.path !== source.serverRoot + ".msf" ||
        source.storeContractID !==
          {
            mbox: "@mozilla.org/msgstore/berkeleystore;1",
            maildir: "@mozilla.org/msgstore/maildirstore;1",
          }[source.storeType] ||
        !["mbox", "maildir"].includes(source.storeType) ||
        !Array.isArray(source.messageKeys) ||
        source.messageKeys.length
      ) {
        throw new Error("Invalid retained startup server-summary origin");
      }
      servers.add(source.serverKey);
    }
    const serverBindings =
      startup.serverSummaries === undefined ? [] : startup.serverSummaries;
    if (!Array.isArray(serverBindings)) {
      throw new Error("Invalid startup server-root binding array");
    }
    if (!startup.bound) {
      if (
        state.stage !== "backup" ||
        state.sources.length ||
        serverBindings.length ||
        startup.databaseSourceId !== null
      ) {
        throw new Error("Startup migration has no native target binding");
      }
      return;
    }
    if (
      typeof startup.databaseSourceId !== "string" ||
      !startup.databaseSourceId ||
      state.sources.length !== startup.inventory.sources.length ||
      serverBindings.length !== serverSummaries.length
    ) {
      throw new Error("Startup migration lost its native incarnation");
    }
    const rootIds = new Set();
    for (const [index, binding] of serverBindings.entries()) {
      if (
        binding.sourceId !== serverSummaries[index].id ||
        !Number.isSafeInteger(binding.folderId) ||
        binding.folderId <= 0 ||
        rootIds.has(binding.folderId) ||
        state.sources.some(
          source => source.destinationFolderId === binding.folderId
        )
      ) {
        throw new Error("Invalid retained startup native server-root binding");
      }
      rootIds.add(binding.folderId);
    }
    for (let index = 0; index < state.sources.length; index++) {
      const source = state.sources[index];
      const original = startup.inventory.sources[index];
      if (
        source.databaseSourceId !== startup.databaseSourceId ||
        Object.keys(original).some(
          key => JSON.stringify(source[key]) !== JSON.stringify(original[key])
        )
      ) {
        throw new Error("Startup migration inventory or incarnation changed");
      }
    }
    if (["validate", "activate", "complete"].includes(state.stage)) {
      const caches = state.caches ?? [];
      if (
        caches.length !== startup.inventory.caches.length ||
        startup.inventory.caches.some(
          input =>
            !caches.some(cache =>
              ["id", "path", "sha256", "size"].every(
                key => cache[key] === input[key]
              )
            )
        )
      ) {
        throw new Error("Startup migration omitted a retained cache source");
      }
    }
    if (["activate", "complete"].includes(state.stage)) {
      this.#requireStartupReadiness(state);
    }
  }

  /** @param {object} state - Complete imported and published startup units. */
  #requireStartupReadiness(state) {
    if (
      !state.startup.bound ||
      state.cancelled ||
      [...state.sources, ...(state.books ?? []), ...(state.caches ?? [])].some(
        unit => unit.state !== "imported" || !unit.receipt
      ) ||
      (state.books ?? []).some(
        book =>
          book.publication?.state !== "published" || !book.publication.receipt
      ) ||
      (state.caches ?? []).some(
        cache =>
          ![2, 3].includes(cache.requestVersion) ||
          cache.databaseSourceId !== state.startup.databaseSourceId
      )
    ) {
      throw new Error(
        "Startup activation requires complete native publication"
      );
    }
  }

  #validate(state) {
    if (
      !state ||
      ![
        MAIL_VERSION,
        BOOK_VERSION,
        PHYSICAL_VERSION,
        CACHE_VERSION,
        PROTOCOL_VERSION,
        STARTUP_VERSION,
      ].includes(state.version) ||
      (state.version == CACHE_VERSION ||
      ([PROTOCOL_VERSION, STARTUP_VERSION].includes(state.version) &&
        "caches" in state)
        ? !Array.isArray(state.caches) || !state.caches.length
        : "caches" in state) ||
      ("books" in state &&
        (!Array.isArray(state.books) || !state.books.length)) ||
      (AppConstants.platform == "win" && !isPhysicalJournal(state)) ||
      (state.version === PHYSICAL_VERSION && AppConstants.platform != "win") ||
      (state.version == MAIL_VERSION && "books" in state) ||
      (state.version == BOOK_VERSION &&
        (!Array.isArray(state.books) || !state.books.length)) ||
      !STAGES.includes(state.stage) ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      typeof state.cancelled != "boolean" ||
      !Array.isArray(state.sources) ||
      !PathUtils.isAbsolute(state.profilePath) ||
      !PathUtils.isAbsolute(state.backupPath) ||
      (state.lastError !== null &&
        (typeof state.lastError?.name != "string" ||
          typeof state.lastError?.message != "string")) ||
      !Array.isArray(state.mailPaths) ||
      state.mailPaths.some(path => !PathUtils.isAbsolute(path))
    ) {
      throw new Error("Invalid or unsupported migration journal");
    }
    const file = new FileUtils.File(this.#path);
    this.#validateStartup(state);
    this.#validatePhysicalIdentities(state, file);
    const roots = [state.profilePath, ...state.mailPaths].map(
      path => new FileUtils.File(path)
    );
    if (
      roots.some(
        root =>
          root.equals(file) ||
          root.contains(file) ||
          root.equals(new FileUtils.File(state.backupPath)) ||
          root.contains(new FileUtils.File(state.backupPath))
      ) ||
      new FileUtils.File(state.backupPath).equals(file) ||
      new FileUtils.File(state.backupPath).contains(file)
    ) {
      throw new Error("Journal must be outside source and backup trees");
    }
    const ids = new Set();
    const tokens = new Set();
    const files = [];
    const destinations = new Set();
    for (const source of state.sources) {
      if (
        typeof source.id != "string" ||
        !source.id ||
        ids.has(source.id) ||
        typeof source.token != "string" ||
        !source.token ||
        tokens.has(source.token) ||
        !PathUtils.isAbsolute(source.path) ||
        !isDigest(source.sha256) ||
        !Number.isSafeInteger(source.size) ||
        source.size < 0 ||
        !Number.isSafeInteger(source.destinationFolderId) ||
        source.destinationFolderId <= 0 ||
        destinations.has(source.destinationFolderId) ||
        !Array.isArray(source.messageKeys) ||
        new Set(source.messageKeys).size != source.messageKeys.length ||
        source.messageKeys.some(key => !isKey(key, true)) ||
        !["pending", "importing", "imported"].includes(source.state)
      ) {
        throw new Error("Invalid migration source identity");
      }
      if (isPhysicalJournal(state)) {
        const measured = validateMorkFolderWindowsInventory(source.inventory);
        if (
          typeof source.databaseSourceId != "string" ||
          !source.databaseSourceId ||
          source.databaseSourceId.includes("\0") ||
          source.path !== measured.summary.canonicalPath ||
          source.physicalIdentity.id !== measured.summary.id ||
          source.physicalIdentity.parentId !== measured.summary.parentId ||
          [measured.summary, measured.store].some(
            record =>
              !state.originalRoots.some(
                root =>
                  root.originalPath === record.originalRoot &&
                  root.canonicalPath === record.canonicalRoot &&
                  root.physicalIdentity.id === record.rootId
              )
          )
        ) {
          throw new Error("Migration original source/root inventory changed");
        }
      } else if (source.inventory !== undefined) {
        throw new Error("Original Windows inventory requires journal version4");
      }
      const sourceFile = new FileUtils.File(normalizedPath(source.path));
      if (
        !roots.some(root => root.contains(sourceFile)) ||
        files.some(other => sourceFile.equals(other)) ||
        sourceFile.parent.contains(file)
      ) {
        throw new Error(
          "Duplicate migration source or journal inside mail storage"
        );
      }
      files.push(sourceFile);
      destinations.add(source.destinationFolderId);
      ids.add(source.id);
      tokens.add(source.token);
      if (source.state == "imported") {
        this.#validateReceipt(source, source.receipt);
      } else if (source.receipt !== null) {
        throw new Error("Uncommitted migration source has a receipt");
      }
    }
    this.#validateCaches(state, roots, file, ids, tokens, files);
    this.#validateBooksAndStage(state, roots, file, ids, tokens, files);
  }

  #validatePhysicalIdentities(state, file) {
    if (
      !isPhysicalJournal(state) &&
      (state.profilePhysicalIdentity !== undefined ||
        state.workPhysicalIdentity !== undefined ||
        [
          ...state.sources,
          ...(state.books ?? []),
          ...(state.caches ?? []),
        ].some(source => source.physicalIdentity !== undefined))
    ) {
      throw new Error("Physical identities require migration journal version4");
    }
    if (isPhysicalJournal(state)) {
      if (
        !Array.isArray(state.originalRoots) ||
        !state.originalRoots.length ||
        JSON.stringify(state.originalRoots) !==
          JSON.stringify(
            captureWindowsMigrationRoots(
              state.originalRoots.map(root => root.originalPath)
            )
          ) ||
        [state.profilePath, ...state.mailPaths].some(
          path => !state.originalRoots.some(root => root.canonicalPath === path)
        )
      ) {
        throw new Error("Migration original root inventory changed");
      }
      if (
        !samePhysical(
          state.profilePhysicalIdentity,
          physicalIdentity(state.profilePath, true)
        ) ||
        !samePhysical(
          state.workPhysicalIdentity,
          physicalIdentity(file.parent.path, true)
        ) ||
        [
          ...state.sources,
          ...(state.books ?? []),
          ...(state.caches ?? []),
        ].some(source => !isMigrationPhysicalIdentity(source.physicalIdentity))
      ) {
        throw new Error("Invalid migration journal physical identity");
      }
    }
  }

  #validateCaches(state, roots, file, ids, tokens, files) {
    const cacheFolders = new Set();
    for (const cache of state.caches ?? []) {
      createMorkFolderCacheRequest(cache);
      getMorkFolderCacheCells(cache.folders);
      if (
        cache.requestVersion >= 2 &&
        (cache.proof.profilePath !== state.profilePath ||
          cache.proof.manifest.path !== state.backup?.path ||
          cache.proof.manifest.sha256 !== state.backup.sha256)
      ) {
        throw new Error(
          "Cache reconciliation proof differs from the journal backup"
        );
      }
      const source = new FileUtils.File(normalizedPath(cache.path));
      if (
        cache.path !== source.path ||
        ids.has(cache.id) ||
        tokens.has(cache.token) ||
        !roots.some(root => root.contains(source)) ||
        files.some(other => source.equals(other)) ||
        source.parent.contains(file) ||
        (!state.sources.length &&
          !(
            state.version === STARTUP_VERSION &&
            state.startup?.bound &&
            state.startup.databaseSourceId === cache.databaseSourceId
          )) ||
        state.sources.some(
          s => s.databaseSourceId !== cache.databaseSourceId
        ) ||
        !["pending", "importing", "imported"].includes(cache.state)
      ) {
        throw new Error("Invalid cache journal identity");
      }
      for (const folder of cache.folders) {
        if (
          cacheFolders.has(folder.id) ||
          [
            folder.cachePath,
            folder.storePath,
            ...(cache.requestVersion >= 2 && !folder.isServer
              ? [folder.originalSummaryPath]
              : []),
          ].some(path => {
            const child = new FileUtils.File(normalizedPath(path));
            return (
              child.path !== path ||
              !roots.some(root => root.equals(child) || root.contains(child))
            );
          })
        ) {
          throw new Error("Invalid cache journal binding");
        }
        cacheFolders.add(folder.id);
      }
      if (cache.state == "imported") {
        validateMorkFolderCacheReceipt(cache, cache.receipt);
      } else if (cache.receipt !== null) {
        throw new Error("Uncommitted cache has a receipt");
      }
      ids.add(cache.id);
      tokens.add(cache.token);
      files.push(source);
    }
  }

  #validateBooksAndStage(state, roots, file, ids, tokens, files) {
    const publicationUIDs = new Set();
    const stages = [];
    for (const book of state.books ?? []) {
      if (
        typeof book.id != "string" ||
        !book.id ||
        ids.has(book.id) ||
        typeof book.token != "string" ||
        !book.token ||
        tokens.has(book.token) ||
        !PathUtils.isAbsolute(book.path) ||
        !isDigest(book.sha256) ||
        !Number.isSafeInteger(book.size) ||
        book.size < 0 ||
        !PathUtils.isAbsolute(book.stagingPath) ||
        ![book.cardKeys, book.listKeys].every(
          keys =>
            Array.isArray(keys) &&
            new Set(keys).size == keys.length &&
            keys.every(
              key => Number.isInteger(key) && key >= 0 && key <= 0xffffffff
            )
        ) ||
        !["pending", "importing", "imported"].includes(book.state)
      ) {
        throw new Error("Invalid migration book identity");
      }
      const source = new FileUtils.File(normalizedPath(book.path));
      const stage = new FileUtils.File(normalizedPath(book.stagingPath));
      if (
        source.path != book.path ||
        stage.path != book.stagingPath ||
        !roots.some(root => root.contains(source)) ||
        files.some(other => source.equals(other)) ||
        !stage.parent.equals(file.parent) ||
        !stage.leafName.endsWith(".sqlite") ||
        stage.equals(file) ||
        stages.some(other => stage.equals(other)) ||
        (book.state == "pending" && stage.exists())
      ) {
        throw new Error("Invalid or occupied book staging path");
      }
      stages.push(stage);
      files.push(source);
      ids.add(book.id);
      tokens.add(book.token);
      if (book.state == "imported") {
        this.#validateBookReceipt(book, book.receipt, state);
      } else if (book.receipt !== null) {
        throw new Error("Uncommitted migration book has a receipt");
      }
      this.#validateBookPublication(book);
      if (book.publication) {
        if (publicationUIDs.has(book.publication.bookUID)) {
          throw new Error("Duplicate book publication UID");
        }
        publicationUIDs.add(book.publication.bookUID);
      }
    }
    this.#validateProtocolUnits(state);
    if (
      isPhysicalJournal(state) &&
      state.version !== STARTUP_VERSION &&
      ["activate", "complete"].includes(state.stage)
    ) {
      // Explicit journal4/6 work has no native activation owner. The startup
      // journal7 is activated only by the live native startup operation.
      throw new Error("Windows migration activation remains held");
    }
    if (
      state.version !== STARTUP_VERSION &&
      (state.books?.length || state.caches?.length) &&
      ["activate", "complete"].includes(state.stage)
    ) {
      throw new Error(
        "Book/cache publication and activation are not supported"
      );
    }
    if (
      state.stage == "backup" &&
      (state.backup !== null ||
        [
          ...state.sources,
          ...(state.books ?? []),
          ...(state.caches ?? []),
        ].some(source => source.state != "pending"))
    ) {
      throw new Error("Migration work precedes backup completion");
    }
    if (
      state.stage != "backup" &&
      (!state.backup ||
        !isDigest(state.backup.sha256) ||
        state.backup.path != PathUtils.join(state.backupPath, "manifest.json"))
    ) {
      throw new Error("Migration has no complete backup receipt");
    }
    if (
      ["validate", "activate", "complete"].includes(state.stage) &&
      [...state.sources, ...(state.books ?? []), ...(state.caches ?? [])].some(
        source => source.state != "imported"
      )
    ) {
      throw new Error("Migration stage skips incomplete imports");
    }
  }
}

/**
 * @param {object} state - Retained journal state.
 * @returns {boolean} Whether Windows physical admission is required.
 */
function isPhysicalJournal(state) {
  return (
    AppConstants.platform == "win" &&
    [PHYSICAL_VERSION, PROTOCOL_VERSION, STARTUP_VERSION].includes(
      state.version
    )
  );
}

/** @param {unknown} value - Hash value. @returns {boolean} Whether it is SHA-256. */
function isDigest(value) {
  return typeof value == "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * @param {unknown} value - Message key.
 * @param {boolean} old - Whether zero is allowed for an original source key.
 * @returns {boolean} Whether it is an unsigned key excluding the sentinel.
 */
function isKey(value, old) {
  return (
    Number.isInteger(value) && value >= (old ? 0 : 1) && value < 0xffffffff
  );
}

/** @param {string} path - Absolute input path. @returns {string} Normalized path. */
function normalizedPath(path) {
  if (!PathUtils.isAbsolute(path)) {
    throw new Error("Migration paths must be absolute");
  }
  const file = new FileUtils.File(path);
  if (AppConstants.platform == "win") {
    const kind =
      file.exists() && file.isDirectory()
        ? Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
        : Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING;
    const lease = admitWindowsMigrationPath(file, kind);
    try {
      return lease.canonicalPath;
    } finally {
      lease.close();
    }
  }
  let link = false;
  try {
    link = file.isSymlink();
  } catch (error) {
    if (error.result != Cr.NS_ERROR_FILE_NOT_FOUND) {
      throw error;
    }
    const parent = file.parent;
    parent.normalize();
    parent.append(file.leafName);
    return parent.path;
  }
  if (link) {
    throw new Error("Migration path contains a link");
  }
  file.normalize();
  return file.path;
}

/** @param {string} path - Existing original path. @param {boolean} [directory=false] - Expected directory. @param {boolean} [stage=false] - Caller-owned writable stage. @returns {object} Exact native pin. */
function physicalIdentity(path, directory = false, stage = false) {
  let kind = Ci.nsIPanoramaMigrationFileSystem.KIND_FILE;
  if (directory) {
    kind = Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY;
  } else if (stage) {
    kind = Ci.nsIPanoramaMigrationFileSystem.KIND_FILE_OR_MISSING;
  }
  const lease = admitWindowsMigrationPath(new FileUtils.File(path), kind);
  try {
    return migrationPhysicalIdentity(lease);
  } finally {
    lease.close();
  }
}

/** @param {object} left - Observed pin. @param {object} right - Retained pin. @returns {boolean} Same full physical identity. */
function samePhysical(left, right) {
  return (
    isMigrationPhysicalIdentity(left) &&
    isMigrationPhysicalIdentity(right) &&
    left.id === right.id &&
    left.parentId === right.parentId
  );
}

/**
 * Checks that a retained IMAP origin cache key names its summary file: the
 * summary's exact descriptor, or another spelling of the same existing file
 * that Thunderbird used when it wrote the entry.
 *
 * @param {string} key - Retained original cache key.
 * @param {string} path - Original summary path.
 * @returns {boolean} Whether the key is this summary's entry.
 */
function startupOriginKeyNamesSummary(key, path) {
  const descriptor = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(
    MailStringUtils.byteStringToUint8Array(
      new FileUtils.File(path).persistentDescriptor
    )
  );
  if (key === descriptor) {
    return true;
  }
  const identity = originalPathIdentity(path);
  return !!identity && originalPathIdentity(key) === identity;
}

/**
 * Validates retained discovery inputs independently of native target outputs.
 * Native startup also verifies their original backed-up bytes and provider.
 *
 * @param {object} source - Original summary/store and persisted server identity.
 * @param {object[]} caches - Complete retained original cache file identities.
 * @throws {Error} For incomplete or contradictory discovery inputs.
 */
function validateStartupFolderOrigin(source, caches) {
  const contract = {
    mbox: "@mozilla.org/msgstore/berkeleystore;1",
    maildir: "@mozilla.org/msgstore/maildirstore;1",
  }[source.storeType];
  if (
    typeof source.serverKey !== "string" ||
    !source.serverKey ||
    source.serverKey.includes("\0") ||
    !PathUtils.isAbsolute(source.serverRoot) ||
    normalizedPath(source.serverRoot) !== source.serverRoot ||
    !new FileUtils.File(source.serverRoot).contains(
      new FileUtils.File(source.path)
    ) ||
    !source.path.endsWith(".msf") ||
    source.storePath !== source.path.slice(0, -4) ||
    !contract ||
    source.storeContractID !== contract ||
    !MIGRATED_MAIL_PROTOCOLS.includes(source.protocol) ||
    source.origin?.provider !==
      (LOCAL_STORE_PROTOCOLS.includes(source.protocol)
        ? "local-store-discovery"
        : { nntp: "news-provider-discovery", imap: "imap-client-discovery" }[
            source.protocol
          ]) ||
    (source.protocol === "nntp" &&
      new FileUtils.File(source.path).parent.path !== source.serverRoot)
  ) {
    throw new Error("Invalid retained startup folder origin");
  }
  if (source.protocol !== "imap") {
    return;
  }
  const origin = source.origin;
  const cache = origin.cache;
  if (
    !cache ||
    !caches.some(
      input =>
        ["path", "sha256", "size"].every(key => input[key] === cache[key]) &&
        input.cacheKeys?.includes(cache.originalKey) &&
        (cache.sourceFormat === "json"
          ? input.sourceFormat === "json"
          : !Object.hasOwn(input, "sourceFormat"))
    ) ||
    !startupOriginKeyNamesSummary(cache.originalKey, source.path) ||
    (cache.sourceFormat === "json"
      ? Object.hasOwn(cache, "sourceKey")
      : Object.hasOwn(cache, "sourceFormat") ||
        !Number.isInteger(cache.sourceKey) ||
        cache.sourceKey < 0 ||
        cache.sourceKey > 0xffffffff) ||
    !["onlineName", "hierDelim", "boxFlags"].every(
      key => typeof origin.originalCells?.[key] === "string"
    ) ||
    typeof origin.onlineName !== "string" ||
    !origin.onlineName ||
    origin.onlineName.includes("\0") ||
    !Number.isInteger(origin.hierarchyDelimiter) ||
    origin.hierarchyDelimiter <= 0 ||
    origin.hierarchyDelimiter > 127 ||
    ([94, 124].includes(origin.hierarchyDelimiter) &&
      (origin.onlineName.includes("/") ||
        origin.onlineName.includes(
          String.fromCharCode(origin.hierarchyDelimiter)
        ))) ||
    !Number.isInteger(origin.boxFlags) ||
    origin.boxFlags < 0 ||
    origin.boxFlags > 0xffffffff
  ) {
    throw new Error("Invalid retained startup IMAP cache origin");
  }
}
