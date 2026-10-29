/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import {
  verifyMigrationBackup,
  captureWindowsMigrationRoots,
} from "resource:///modules/panorama/MigrationBackup.sys.mjs";
import {
  validateMorkFolderWindowsInventory,
  validateMorkFolderWindowsReceipt,
} from "resource:///modules/panorama/MorkFolderImport.sys.mjs";

import {
  admitWindowsMigrationPath,
  migrationPhysicalIdentity,
  isMigrationPhysicalIdentity,
} from "resource:///modules/panorama/MigrationSource.sys.mjs";

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
   *   sources: object[], books?: object[]}} plan - Mail sources retain version1
   *   fields. Books have id, path, sha256, size, cardKeys, listKeys and stagingPath.
   *   Each stage is a fresh .sqlite child of the private journal directory.
   *   Windows version4 requires original roots and each mail source.inventory (version2),
   *   plus actual source/profile/work physical IDs. Older Windows progress is refused.
   * @returns {Promise<MigrationJournal>} Open journal at the backup stage.
   */
  static async create(path, plan) {
    const journal = new MigrationJournal(path);
    try {
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
      const state = {
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
      if (state.version == PHYSICAL_VERSION) {
        state.profilePhysicalIdentity = physicalIdentity(
          state.profilePath,
          true
        );
        state.workPhysicalIdentity = physicalIdentity(
          new FileUtils.File(journal.#path).parent.path,
          true
        );
        for (const source of [...state.sources, ...(state.books ?? [])]) {
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
      this.#validateReceipt(source, receipt);
      const normalized = {
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
        [...state.sources, ...(state.books ?? [])].some(
          source => source.state != "imported"
        )
      ) {
        throw new Error("Migration imports are incomplete");
      }
      if (stage != "import" && state.books?.length) {
        throw new Error(
          "Staged book publication and activation are not supported"
        );
      }
      if (!["import", "validate", "activate"].includes(stage)) {
        throw new Error("Invalid migration stage transition");
      }
      state.stage = STAGES[STAGES.indexOf(stage) + 1];
      return true;
    });
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
      const hash = await IOUtils.computeHexDigest(source.path, "sha256");
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
      state.version == PHYSICAL_VERSION &&
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
      state.version == PHYSICAL_VERSION &&
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
    for (const root of manifest.roots) {
      for (const entry of root.entries) {
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
    for (const source of [...state.sources, ...(state.books ?? [])]) {
      if (source.inventory) {
        const measured = validateMorkFolderWindowsInventory(source.inventory);
        const stored = filesByPath.get(measured.store.canonicalPath);
        if (
          measured.store.id
            ? !stored ||
              stored.physicalIdentity.id !== measured.store.id ||
              stored.physicalIdentity.parentId !== measured.store.parentId ||
              (await IOUtils.stat(measured.store.canonicalPath)).size !==
                stored.size ||
              (await IOUtils.computeHexDigest(
                measured.store.canonicalPath,
                "sha256"
              )) !== stored.sha256
            : !!stored
        ) {
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
    if (
      actual.sha256 != (await IOUtils.computeHexDigest(actual.path, "sha256"))
    ) {
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
    if (state.version != PHYSICAL_VERSION) {
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

  #validate(state) {
    if (
      !state ||
      ![MAIL_VERSION, BOOK_VERSION, PHYSICAL_VERSION].includes(state.version) ||
      ("books" in state &&
        (!Array.isArray(state.books) || !state.books.length)) ||
      (AppConstants.platform == "win" && state.version != PHYSICAL_VERSION) ||
      (state.version == PHYSICAL_VERSION && AppConstants.platform != "win") ||
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
    if (
      state.version != PHYSICAL_VERSION &&
      (state.profilePhysicalIdentity !== undefined ||
        state.workPhysicalIdentity !== undefined ||
        [...state.sources, ...(state.books ?? [])].some(
          source => source.physicalIdentity !== undefined
        ))
    ) {
      throw new Error("Physical identities require migration journal version4");
    }
    if (state.version == PHYSICAL_VERSION) {
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
        [...state.sources, ...(state.books ?? [])].some(
          source => !isMigrationPhysicalIdentity(source.physicalIdentity)
        )
      ) {
        throw new Error("Invalid migration journal physical identity");
      }
    }
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
      if (state.version == PHYSICAL_VERSION) {
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
    this.#validateBooksAndStage(state, roots, file, ids, tokens, files);
  }

  #validateBooksAndStage(state, roots, file, ids, tokens, files) {
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
    }
    if (
      state.version == PHYSICAL_VERSION &&
      ["activate", "complete"].includes(state.stage)
    ) {
      throw new Error("Windows migration activation remains held");
    }
    if (state.books?.length && ["activate", "complete"].includes(state.stage)) {
      throw new Error(
        "Staged book publication and activation are not supported"
      );
    }
    if (
      state.stage == "backup" &&
      (state.backup !== null ||
        [...state.sources, ...(state.books ?? [])].some(
          source => source.state != "pending"
        ))
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
      [...state.sources, ...(state.books ?? [])].some(
        source => source.state != "imported"
      )
    ) {
      throw new Error("Migration stage skips incomplete imports");
    }
  }
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
