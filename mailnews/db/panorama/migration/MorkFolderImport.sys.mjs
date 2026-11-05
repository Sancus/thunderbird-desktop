/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { MailStringUtils } from "resource:///modules/MailStringUtils.sys.mjs";
import { MorkImportError } from "resource:///modules/MorkParser.sys.mjs";
import { readMorkMigrationSource } from "resource:///modules/panorama/MigrationSource.sys.mjs";
import { getMorkThreadRelations } from "resource:///modules/panorama/MigrationMessageMap.sys.mjs";

/**
 * @typedef {object} MorkImportMessageInput
 * @property {number} sourceKey - Original folder-local row key, not an allocation.
 * @property {number} rootSourceKey - Original semantic thread root.
 * @property {number|null} parentSourceKey - Original parent or no parent.
 * @property {{messageId: string, references: string[], date: number,
 *   dateReceived: number, sender: string, recipients: string, ccList: string,
 *   bccList: string, subject: string, flags: number, keywords: string,
 *   priority: number, charset: string, accountKey: string,
 *   messageSize?: number, storeToken?: string, offlineMessageSize?: number,
 *   lineCount?: number, extras: {k: string, v: string}[]}} header -
 *   RawHdr-shaped values. Extras retain exact original text and cell order.
 */

/**
 * @typedef {object} MorkImportRecords
 * @property {{id: number, scope: string, cells: {k: string, v: string}[]}[]} rows -
 *   All original scoped rows; cell names/values are byte strings.
 * @property {{id: number, scope: string, cells: {k: string, v: string}[],
 *   rows: string[], metaRow: string|null}[]} tables - Full ordered memberships.
 */

/**
 * @typedef {object} MorkFolderBinding
 * @property {number} id - Existing destination folder identity.
 * @property {string} uri - Original native folder URI.
 * @property {string} summaryPath - Original summary path.
 * @property {string} storePath - Original body-store path.
 * @property {string} storeType - Actual pluggable store descriptor.
 * @property {string} protocol - Native incoming-server type, not a UID mapping.
 * @property {boolean} storeExists - Path existence, not individual body validity.
 */

/**
 * @typedef {object} MorkWindowsPath
 * @property {string} originalPath - Inventory spelling before normalization.
 * @property {string} originalRoot - Explicit selected original root spelling.
 * @property {string} id - Full native file ID; empty only for an absent store.
 * @property {string} parentId - Full native parent directory ID.
 * @property {string} rootId - Full native selected root ID.
 */

/**
 * @typedef {object} MorkWindowsInventory
 * @property {2} version - Original-path inventory format.
 * @property {{summary: MorkWindowsPath, store: MorkWindowsPath}} windowsAdmission -
 *   Retained native measurements; core independently measures its import leases.
 */

/**
 * Reads an original folder through the strict reader for native import.
 * Binds the snapshot to the actual folder ID, URI, summary and store paths.
 * Requires quiesced writers and the complete verified upgrade backup.
 * Does not import, allocate keys, open a legacy DB or modify source/body files.
 *
 * @param {nsIMsgFolder} folder - Actual source folder with its destination ID.
 * @param {string} token - Stable journal operation token, reused after restart.
 * @param {MorkWindowsInventory} [inventory] - Retained Windows original-path inventory.
 *   Capture before normalization; never reconstruct it from canonical paths.
 * @returns {Promise<{version: number, token: string, folder: MorkFolderBinding,
 *   source: {path: string, size: number, sha256: string, messageKeys: number[]},
 *   messages: MorkImportMessageInput[], records: MorkImportRecords,
 *   windowsAdmission?: {summary: MorkWindowsPath, store: MorkWindowsPath}}>}
 *   Owned version1 input, or Windows version2 with windowsAdmission from inventory:
 *   folder/source identities, messages and complete raw source records.
 *   Store existence is not proof that individual message bodies are available.
 * @throws {Error} For invalid identity, changed source, or unsupported data.
 */
export async function readMorkFolderImport(folder, token, inventory) {
  if (typeof token != "string" || !token || token.includes("\0")) {
    throw new Error("Expected a stable migration token");
  }
  folder.QueryInterface(Ci.nsIMsgFolder);
  const paths =
    inventory === undefined ? null : admitWindowsInventory(folder, inventory);
  try {
    const before = await bindFolder(folder, paths?.canonical);
    const { summary, identity } = await readMorkMigrationSource(
      paths ? paths.admission.summary.originalPath : before.summaryPath
    );
    const data = createMorkImportData(summary);
    const after = await bindFolder(folder, paths?.canonical);
    paths?.validate();
    if (
      JSON.stringify(before) != JSON.stringify(after) ||
      (paths
        ? identity.path !== before.summaryPath ||
          identity.physicalIdentity?.version !== 1 ||
          identity.physicalIdentity?.id !== paths.admission.summary.id ||
          identity.physicalIdentity?.parentId !==
            paths.admission.summary.parentId
        : !new FileUtils.File(identity.path).equals(
            new FileUtils.File(before.summaryPath)
          ))
    ) {
      throw new Error("Migration folder identity changed while reading");
    }
    return {
      version: paths ? 2 : 1,
      token,
      folder: before,
      source: identity,
      ...data,
      ...(paths ? { windowsAdmission: paths.admission } : {}),
    };
  } finally {
    paths?.close();
  }
}

/**
 * Captures original Windows paths and native IDs before normalizing inventory.
 * The caller selects roots from its original profile/mail inventory and retains
 * this result unchanged for retries. No database is opened or file written.
 * Collection leases close on return; core must own its import leases separately.
 * This does not authorize import, checkpoint, startup or activation.
 *
 * @param {nsIFile} summary - Original discovered summary file.
 * @param {nsIFile} summaryRoot - Explicit selected original summary root.
 * @param {nsIFile} store - Original mbox file or maildir directory; may be absent.
 * @param {nsIFile} storeRoot - Explicit selected original store root.
 * @returns {MorkWindowsInventory} Exact original strings and native IDs.
 * @throws {Error} For unsupported platforms, paths or native admission errors.
 */
export function captureMorkFolderWindowsInventory(
  summary,
  summaryRoot,
  store,
  storeRoot
) {
  const fs = windowsFileSystem();
  const leases = [];
  try {
    const capture = (file, root, kind) => {
      const originalPath = file.QueryInterface(Ci.nsIFile).path;
      const originalRoot = root.QueryInterface(Ci.nsIFile).path;
      const lease = fs.admit(file, root, kind);
      leases.push(lease);
      fs.validate(lease);
      return {
        originalPath,
        originalRoot,
        id: lease.identity,
        parentId: lease.parentIdentity,
        rootId: lease.rootIdentity,
      };
    };
    const windowsAdmission = {
      summary: capture(summary, summaryRoot, fs.KIND_FILE),
      store: capture(store, storeRoot, windowsStoreKind(fs, store)),
    };
    for (const lease of leases) {
      fs.validate(lease);
    }
    if (leases[0].identity === leases[1].identity) {
      throw new Error("Migration summary and store are the same file");
    }
    return { version: 2, windowsAdmission };
  } finally {
    for (const lease of leases) {
      lease.close();
    }
  }
}

/**
 * Rechecks retained original inventory without a folder or database startup.
 * Returns current measurements for comparison, never import/commit proof.
 *
 * @param {MorkWindowsInventory} inventory - Persisted original-path intent.
 * @param {nsIMsgFolder} [folder] - Actual native folder to bind independently.
 * @returns {object} Summary/store identities with canonical path/root strings.
 */
export function validateMorkFolderWindowsInventory(inventory, folder) {
  folder?.QueryInterface(Ci.nsIMsgFolder);
  const paths = admitWindowsInventory(folder ?? null, inventory);
  try {
    paths.validate();
    return structuredClone(paths.measured);
  } finally {
    paths.close();
  }
}

/**
 * Checks core065's complete measured receipt against retained original intent.
 * The caller must obtain this receipt from the actual native import/lookup API.
 *
 * @param {MorkWindowsInventory} inventory - Persisted original-path intent.
 * @param {object} receipt - Native committed version2 receipt.
 * @returns {void}
 */
export function validateMorkFolderWindowsReceipt(inventory, receipt) {
  const measured = validateMorkFolderWindowsInventory(inventory);
  const fields = [
    "originalPath",
    "originalRoot",
    "id",
    "parentId",
    "rootId",
    "canonicalPath",
    "canonicalRoot",
  ];
  if (
    receipt?.version !== 2 ||
    !receipt.windowsAdmission ||
    Object.keys(receipt.windowsAdmission).length != 2 ||
    ["summary", "store"].some(kind => {
      const value = receipt.windowsAdmission[kind];
      return (
        !value ||
        Object.keys(value).length != fields.length ||
        fields.some(name => value[name] !== measured[kind][name])
      );
    }) ||
    receipt.sourcePhysicalIdentity?.version !== 1 ||
    receipt.sourcePhysicalIdentity.id !== measured.summary.id ||
    receipt.sourcePhysicalIdentity.parentId !== measured.summary.parentId
  ) {
    throw new Error(
      "Native Windows migration receipt differs from original inventory"
    );
  }
}

/** @returns {nsIPanoramaMigrationFileSystem} Actual stateless Windows service. */
function windowsFileSystem() {
  if (AppConstants.platform != "win") {
    throw new Error("Windows migration inventory requires Windows");
  }
  return Cc[
    "@mozilla.org/mailnews/panorama-migration-file-system;1"
  ].getService(Ci.nsIPanoramaMigrationFileSystem);
}

/**
 * Selects directory admission for an existing store directory.
 * Native admission must still verify the original path and physical identity.
 *
 * @param {nsIPanoramaMigrationFileSystem} fs - Actual Windows admission service.
 * @param {nsIFile} file - Original store path, before normalization.
 * @returns {number} Directory or file-or-missing admission kind.
 */
function windowsStoreKind(fs, file) {
  file.QueryInterface(Ci.nsIFile);
  return file.exists() && file.isDirectory()
    ? fs.KIND_DIRECTORY
    : fs.KIND_FILE_OR_MISSING;
}

/**
 * Re-admits retained originals before canonical binding or reading source bytes.
 * Native IDs are comparisons, never proof that a later import owns a lease.
 *
 * @param {nsIMsgFolder} folder - Actual native source folder.
 * @param {MorkWindowsInventory} inventory - Unchanged original-path inventory.
 * @returns {object} Private collection leases, canonical paths and checked fields.
 * @throws {Error} For old/missing/changed inventory or native admission errors.
 */
function admitWindowsInventory(folder, inventory) {
  const fs = windowsFileSystem();
  const saved = structuredClone(inventory);
  if (
    saved?.version !== 2 ||
    !saved.windowsAdmission ||
    Object.keys(saved.windowsAdmission).length != 2
  ) {
    throw new Error("Expected retained Windows migration inventory version2");
  }
  const id = /^[0-9a-f]{16}:[0-9a-f]{32}$/;
  const names = ["originalPath", "originalRoot", "id", "parentId", "rootId"];
  for (const kind of ["summary", "store"]) {
    const record = saved.windowsAdmission[kind];
    if (
      !record ||
      Object.keys(record).length != names.length ||
      names.some(name => !Object.hasOwn(record, name)) ||
      [record.originalPath, record.originalRoot].some(
        path =>
          typeof path != "string" ||
          path.includes("\0") ||
          !PathUtils.isAbsolute(path)
      ) ||
      [record.id, record.parentId, record.rootId].some(
        value => typeof value != "string"
      ) ||
      !id.test(record.parentId) ||
      !id.test(record.rootId) ||
      (!(kind == "store" && record.id === "") && !id.test(record.id))
    ) {
      throw new Error(
        "Missing or invalid original Windows migration paths/IDs"
      );
    }
  }
  const admission = saved.windowsAdmission;
  const leases = [];
  try {
    for (const kind of ["summary", "store"]) {
      const record = admission[kind];
      const original = new FileUtils.File(record.originalPath);
      const lease = fs.admit(
        original,
        new FileUtils.File(record.originalRoot),
        kind == "summary" ? fs.KIND_FILE : windowsStoreKind(fs, original)
      );
      leases.push(lease);
      if (
        lease.identity !== record.id ||
        lease.parentIdentity !== record.parentId ||
        lease.rootIdentity !== record.rootId
      ) {
        throw new Error("Retained Windows migration physical identity changed");
      }
    }
    const canonical = {
      summaryPath: leases[0].canonicalPath,
      storePath: leases[1].canonicalPath,
    };
    if (
      canonical.summaryPath === canonical.storePath ||
      leases[0].identity === leases[1].identity
    ) {
      throw new Error("Migration summary and store are the same file");
    }
    const validate = () => {
      for (const lease of leases) {
        fs.validate(lease);
      }
      if (!folder) {
        return;
      }
      for (const [kind, file, retained] of [
        ["summary", folder.summaryFile, leases[0]],
        ["store", folder.filePath, leases[1]],
      ]) {
        const actual = fs.admit(
          file,
          new FileUtils.File(admission[kind].originalRoot),
          retained.kind
        );
        try {
          fs.validate(actual);
          if (
            actual.canonicalPath !== retained.canonicalPath ||
            actual.canonicalRoot !== retained.canonicalRoot ||
            actual.identity !== retained.identity ||
            actual.parentIdentity !== retained.parentIdentity ||
            actual.rootIdentity !== retained.rootIdentity
          ) {
            throw new Error(
              "Original Windows inventory differs from native folder"
            );
          }
        } finally {
          actual.close();
        }
      }
    };
    validate();
    return {
      admission,
      canonical,
      measured: Object.fromEntries(
        ["summary", "store"].map((kind, index) => [
          kind,
          {
            ...admission[kind],
            canonicalPath: leases[index].canonicalPath,
            canonicalRoot: leases[index].canonicalRoot,
          },
        ])
      ),
      validate,
      close() {
        for (const lease of leases) {
          lease.close();
        }
      },
    };
  } catch (error) {
    for (const lease of leases) {
      lease.close();
    }
    throw error;
  }
}

/**
 * Converts parsed source data to RawHdr-shaped native import input.
 * Decodes and NFC-normalizes only the standard fields normalized by the current
 * FolderMigrator. Every original cell remains separately in exact-text extras.
 * Raw record cells are byte strings, including unknown/non-message records.
 * A native receiver must consume or reject required records before completion.
 *
 * @param {{messages: object[], source: object}} summary - Strict mail snapshot.
 * @returns {{messages: MorkImportMessageInput[], records: MorkImportRecords}}
 *   Complete input, without destination key allocation.
 * @throws {MorkImportError} For invalid structural numbers/relationships.
 */
export function createMorkImportData(summary) {
  const relations = getMorkThreadRelations(summary);
  const converter = Cc["@mozilla.org/messenger/mimeconverter;1"].getService(
    Ci.nsIMimeConverter
  );
  const messages = summary.messages.map(message => {
    const properties = message.properties;
    const charset = properties.get("msgCharSet") ?? "";
    const decode = name =>
      converter
        .decodeMimeHeaderToUTF8(
          MailStringUtils.stringToByteString(properties.get(name) ?? ""),
          charset,
          true,
          true
        )
        .normalize("NFC");
    const header = {
      messageId: message.messageId.normalize("NFC"),
      references: [...message.references],
      date: message.dateInSeconds * 1000000,
      dateReceived: numberProperty(properties, "dateReceived") * 1000000,
      sender: decode("sender"),
      recipients: decode("recipients"),
      ccList: decode("ccList"),
      bccList: decode("bccList"),
      subject: decode("subject"),
      flags: (message.flags & ~Ci.nsMsgMessageFlags.New) >>> 0,
      keywords: (properties.get("keywords") ?? "").normalize("NFC"),
      priority: numberProperty(properties, "priority", Ci.nsMsgPriority.notSet),
      charset,
      accountKey: properties.get("account") ?? "",
      extras: [...properties].map(([k, v]) => ({ k, v })),
    };
    if (properties.has("size")) {
      header.messageSize = message.messageSize;
    }
    if (properties.has("storeToken") || message.storeToken) {
      header.storeToken = message.storeToken;
    }
    for (const [column, field] of [
      ["offlineMsgSize", "offlineMessageSize"],
      ["numLines", "lineCount"],
    ]) {
      if (properties.has(column)) {
        header[field] = numberProperty(properties, column);
      }
    }
    const relation = relations.get(message.sourceKey);
    return {
      sourceKey: message.sourceKey,
      rootSourceKey: relation.root,
      parentSourceKey: relation.parent,
      header,
    };
  });
  const cells = record => [...record.cells].map(([k, v]) => ({ k, v }));
  const records = {
    rows: [...summary.source.rows.values()].map(row => ({
      id: row.id,
      scope: row.scope,
      cells: cells(row),
    })),
    tables: [...summary.source.tables.values()].map(table => ({
      id: table.id,
      scope: table.scope,
      cells: cells(table),
      rows: [...table.rows],
      metaRow: table.metaRow,
    })),
  };
  return { messages, records };
}

/**
 * Captures physical folder/store identity without opening a message database.
 *
 * @param {nsIMsgFolder} folder - Original folder.
 * @param {object} [canonical] - Paths from retained native Windows admission.
 * @returns {Promise<MorkFolderBinding>} Current native folder/store descriptors.
 * @throws {Error} For missing destination identity or linked/special paths.
 */
async function bindFolder(folder, canonical) {
  const id = folder.id;
  const uri = folder.URI;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof uri != "string" || !uri) {
    throw new Error("Migration folder has no valid destination identity");
  }
  const summary = canonical
    ? new FileUtils.File(canonical.summaryPath)
    : unlinkedFile(folder.summaryFile);
  const store = canonical
    ? new FileUtils.File(canonical.storePath)
    : unlinkedFile(folder.filePath);
  const binding = {
    id,
    uri,
    summaryPath: summary.path,
    storePath: store.path,
    storeType: folder.msgStore.storeType,
    protocol: folder.incomingServerType,
    storeExists: await IOUtils.exists(store.path),
  };
  if (binding.storeExists) {
    const info = await IOUtils.stat(store.path);
    if (!["regular", "directory"].includes(info.type)) {
      throw new Error("Unsupported migration body-store path");
    }
  }
  return binding;
}

/**
 * Clones and normalizes a native path without changing the folder's nsIFile.
 *
 * @param {nsIFile} original - Original native path.
 * @returns {nsIFile} Normalized clone; the leaf cannot be a link.
 * @throws {Error} For a linked leaf or an IO error.
 */
function unlinkedFile(original) {
  const file = original.clone();
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
    return parent;
  }
  if (link) {
    throw new Error("Migration folder path contains a link");
  }
  file.normalize();
  return file;
}

/**
 * Reads only a named structural uint32 column. Generic extras are never typed.
 *
 * @param {Map<string, string>} properties - Exact original cells.
 * @param {string} name - Known structural field.
 * @param {number} [fallback=0] - Native default when absent.
 * @returns {number} Original numeric value.
 * @throws {MorkImportError} For invalid structural text.
 */
function numberProperty(properties, name, fallback = 0) {
  if (!properties.has(name)) {
    return fallback;
  }
  const value = properties.get(name);
  if (!/^[0-9a-f]{1,8}$/i.test(value)) {
    throw new MorkImportError("MALFORMED_MORK", 0, "Invalid " + name);
  }
  return parseInt(value, 16);
}
