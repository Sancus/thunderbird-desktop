/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";
import { parseMorkSummary } from "resource:///modules/panorama/MorkSummaryReader.sys.mjs";
import { parseMorkAddressBook } from "resource:///modules/panorama/MorkAddressBookReader.sys.mjs";
import { parseMorkFolderCache } from "resource:///modules/panorama/MorkFolderCache.sys.mjs";

const MAX_SUMMARY_BYTES = 64 * 1024 * 1024;

/**
 * Hashes an admitted, quiesced file without initializing profile NSS stores.
 * Reads at most 1 MiB at once. Callers retain path admission and source leases;
 * this checks regular-file size and modification time across the hash.
 *
 * @param {string} path - Absolute admitted regular-file path.
 * @returns {Promise<string>} Lowercase SHA-256 of the complete file.
 * @throws {Error} For unsupported files or changes while hashing. Read errors
 *   propagate without replacement.
 */
export async function hashMigrationFile(path) {
  if (!PathUtils.isAbsolute(path)) {
    throw new Error("Migration hash path must be absolute");
  }
  const before = await IOUtils.stat(path);
  if (
    before.type != "regular" ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0
  ) {
    throw new Error("Unsupported migration hash file");
  }
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(Ci.nsICryptoHash.SHA256);
  for (let offset = 0; offset < before.size; ) {
    const maxBytes = Math.min(1024 * 1024, before.size - offset);
    const bytes = await IOUtils.read(path, { offset, maxBytes });
    if (bytes.length != maxBytes) {
      throw new Error("Migration file changed while hashing");
    }
    hash.update(bytes, bytes.length);
    offset += bytes.length;
  }
  const after = await IOUtils.stat(path);
  if (
    after.type != "regular" ||
    after.size != before.size ||
    after.lastModified != before.lastModified
  ) {
    throw new Error("Migration file changed while hashing");
  }
  return Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Retains Windows no-reparse admission; Unix callers keep their existing guards.
 * The immediate parent is the native admission root. Profile/backup scope still
 * belongs to the coordinator. This does not create a path or start a database.
 *
 * @param {nsIFile} file - Original path before normalization.
 * @param {number} kind - nsIPanoramaMigrationFileSystem kind.
 * @returns {?nsIPanoramaMigrationPath} Caller-owned native lease on Windows.
 */
export function admitWindowsMigrationPath(file, kind) {
  if (AppConstants.platform != "win") {
    return null;
  }
  try {
    return Cc["@mozilla.org/mailnews/panorama-migration-file-system;1"]
      .getService(Ci.nsIPanoramaMigrationFileSystem)
      .admit(file, file.parent ?? file, kind);
  } catch (error) {
    // The native refusal names neither the path nor its kind.
    console.error("Windows migration path admission refused", file.path, kind);
    throw error;
  }
}

/**
 * Returns a comparable physical identity of an existing original path, or
 * null when nothing exists there. Windows compares volume/file IDs, so case
 * and short-name spellings of one object agree; elsewhere the normalized
 * path is compared. Native import checks the same physically again.
 *
 * @param {string} path - Original absolute path, e.g. a retained cache key.
 * @returns {?string} Identity, or null for an absent or non-local path.
 */
export function originalPathIdentity(path) {
  let file;
  try {
    file = new FileUtils.File(path);
    if (!file.exists()) {
      return null;
    }
  } catch {
    // Not a local absolute path on this system: no current folder is there.
    return null;
  }
  if (AppConstants.platform == "win") {
    const lease = admitWindowsMigrationPath(
      file,
      file.isDirectory()
        ? Ci.nsIPanoramaMigrationFileSystem.KIND_DIRECTORY
        : Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
    );
    try {
      return "win:" + lease.identity;
    } finally {
      lease.close();
    }
  }
  const normalized = file.clone();
  normalized.normalize();
  return "path:" + normalized.path;
}

/**
 * @param {nsIPanoramaMigrationPath} lease - Open native existing-path lease.
 * @returns {object} Version1 exact physical identity for manifests/journals.
 */
export function migrationPhysicalIdentity(lease) {
  Cc["@mozilla.org/mailnews/panorama-migration-file-system;1"]
    .getService(Ci.nsIPanoramaMigrationFileSystem)
    .validate(lease);
  if (!lease.exists) {
    throw new Error("Migration physical identity requires an existing path");
  }
  return { version: 1, id: lease.identity, parentId: lease.parentIdentity };
}

/** @param {unknown} value - Persisted identity. @returns {boolean} Exact supported format. */
export function isMigrationPhysicalIdentity(value) {
  return (
    value?.version === 1 &&
    [value.id, value.parentId].every(
      id => typeof id == "string" && /^[0-9a-f]{16}:[0-9a-f]{32}$/.test(id)
    )
  );
}

/**
 * Reads owned summary bytes and binds the parsed data to their SHA-256.
 * Requires quiesced profile/store writers. Detects changes across read/hash;
 * retains a native read lease on Windows for this read, not for later imports.
 *
 * @param {string} path - Absolute original summary path.
 * @returns {Promise<{summary: object, identity: object}>} Parsed snapshot and
 *   normalized path, exact byte size, SHA-256 and original message keys.
 */
export async function readMorkMigrationSource(path) {
  const { bytes, identity } = await readMigrationBytes(path);
  const summary = parseMorkSummary(bytes);
  return {
    summary,
    identity: {
      ...identity,
      messageKeys: summary.messages.map(message => message.sourceKey),
    },
  };
}

/**
 * Reads and validates a complete legacy book without writing its original file.
 * Requires the same caller-held profile lock and writer quiescence as mail.
 *
 * @param {string} path - Absolute original .mab path.
 * @returns {Promise<{book: object, bytes: Uint8Array, identity: object}>}
 *   Owned bytes, parsed book, hash/size/path and separate card/list source keys.
 */
export async function readMorkAddressBookSource(path) {
  const { bytes, identity } = await readMigrationBytes(path);
  const book = parseMorkAddressBook(bytes);
  return {
    book,
    bytes,
    identity: {
      ...identity,
      cardKeys: book.cards.map(card => card.sourceKey),
      listKeys: book.lists.map(list => list.sourceKey),
    },
  };
}

/**
 * Reads a strict folder-cache snapshot with its unchanged original bytes.
 * This does not apply metadata or produce a native import receipt.
 *
 * @param {string} path - Absolute original panacea.dat path.
 * @returns {Promise<{cache: object, bytes: Uint8Array, identity: object}>}
 *   Owned parsed records, bytes and canonical path/SHA-256/size.
 */
export async function readMorkFolderCacheSource(path) {
  const { bytes, identity } = await readMigrationBytes(path);
  return { cache: parseMorkFolderCache(bytes), bytes, identity };
}

/**
 * @param {string} path - Absolute quiesced source file.
 * @returns {Promise<{bytes: Uint8Array, identity: object}>} Fingerprinted bytes.
 */
async function readMigrationBytes(path) {
  if (!PathUtils.isAbsolute(path)) {
    throw new Error("Migration source path must be absolute");
  }
  const file = new FileUtils.File(path);
  const lease =
    AppConstants.platform == "win"
      ? admitWindowsMigrationPath(
          file,
          Ci.nsIPanoramaMigrationFileSystem.KIND_FILE
        )
      : null;
  try {
    if (file.isSymlink()) {
      throw new Error("Migration source contains a link");
    }
    if (lease) {
      file.initWithPath(lease.canonicalPath);
    } else {
      file.normalize();
    }
    const before = await IOUtils.stat(file.path);
    if (before.type != "regular" || before.size > MAX_SUMMARY_BYTES) {
      throw new Error("Unsupported migration source type or size");
    }
    // IOUtils allocates maxBytes up front; one byte past the measured size
    // still detects growth without a 64MB buffer per summary.
    const bytes = await IOUtils.read(file.path, {
      maxBytes: before.size + 1,
    });
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
      bytes.length != before.size ||
      after.type != "regular" ||
      after.size != before.size ||
      after.lastModified != before.lastModified ||
      (await hashMigrationFile(file.path)) != sha256
    ) {
      throw new Error("Migration source changed while reading");
    }
    return {
      bytes,
      identity: {
        path: file.path,
        size: bytes.length,
        sha256,
        ...(lease
          ? { physicalIdentity: migrationPhysicalIdentity(lease) }
          : {}),
      },
    };
  } finally {
    lease?.close();
  }
}
