/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IMServices } from "resource:///modules/IMServices.sys.mjs";
import {
  encodeName,
  queueFileOperation,
  readChatPrivacyTarget,
} from "resource:///modules/logger.sys.mjs";
import { chatSearchDocumentId } from "resource:///modules/panorama/ChatSearchProvider.sys.mjs";

/**
 * Erases text and persists deletion flags for an existing remote message ID.
 * Uses the logger file queue so appends and cleanup cannot overwrite this write.
 * Validates the file and its own encoded path identity before replacing it.
 * Unrelated lines stay unchanged.
 *
 * @param {string} filePath - Existing active logger path.
 * @param {string} remoteId - Existing protocol message identity.
 * @param {AbortSignal} [signal] - Cancels before reading or starting a write.
 * @returns {Promise<boolean>} Whether this file changed.
 */
function redactLog(filePath, remoteId, signal) {
  const [protocol, account, folder] = JSON.parse(
    chatSearchDocumentId(filePath).slice(5)
  );
  return queueFileOperation(filePath, async () => {
    signal?.throwIfAborted();
    const bytes = await IOUtils.read(filePath);
    signal?.throwIfAborted();
    const lines = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .split("\n");
    const header = JSON.parse(lines[0]);
    if (
      !header ||
      typeof header.account != "string" ||
      typeof header.normalizedName != "string" ||
      typeof header.isChat != "boolean" ||
      header.protocol !== protocol ||
      encodeName(header.account) !== account ||
      encodeName(header.normalizedName + (header.isChat ? ".chat" : "")) !==
        folder
    ) {
      throw new Error("Chat redaction source does not match its log path");
    }
    let changed = false;
    for (let i = 1; i < lines.length; i++) {
      if (i == lines.length - 1 && lines[i] === "") {
        continue;
      }
      const record = JSON.parse(lines[i]);
      if (
        !record ||
        typeof record.text != "string" ||
        !Array.isArray(record.flags) ||
        record.flags.some(flag => typeof flag != "string") ||
        (record.remoteId != null && typeof record.remoteId != "string")
      ) {
        throw new Error("Invalid chat redaction source record");
      }
      if (record.remoteId !== remoteId) {
        continue;
      }
      if (record.text === "" && record.flags.includes("deleted")) {
        continue;
      }
      record.text = "";
      if (!record.flags.includes("deleted")) {
        record.flags.push("deleted");
      }
      lines[i] = JSON.stringify(record);
      changed = true;
    }
    if (changed) {
      signal?.throwIfAborted();
      await IOUtils.writeUTF8(filePath, lines.join("\n"), {
        tmpPath: filePath + ".panorama-redaction.tmp",
        flush: true,
      });
    }
    return changed;
  });
}

/**
 * Persists explicit noLog/deleted updates in the active writer's existing logs.
 * Erases every recorded version of the remote ID, including rotated files.
 * Does not create logs or store text, sender, time or IDs from a noLog event.
 *
 * The returned paths are a completion handoff for later index refresh. No observer
 * is installed here. Replacement is atomic per file, not across files or SQL.
 * Errors reject with the original failure; earlier files may already be redacted.
 * Cancellation cannot roll back a write already started. Closed writers and
 * historical files outside the active writer need a separate verified mapping.
 *
 * @param {prplIMessage} message - Existing chat notification with stable remoteId.
 * @param {object} [options={}] - Redaction controls.
 * @param {AbortSignal} [options.signal] - Cancels between queued file operations.
 * @returns {Promise<string[]>} Changed log paths after their writes complete.
 *   Empty for an unlogged ID, missing writer, or an event without explicit deletion/noLog.
 * @throws {Error} Original I/O/cancellation errors or invalid log data.
 */
export async function persistChatSearchRedaction(message, { signal } = {}) {
  signal?.throwIfAborted();
  const remoteId = message.remoteId;
  if (
    (message.noLog !== true && message.deleted !== true) ||
    typeof remoteId != "string" ||
    !remoteId
  ) {
    return [];
  }
  const paths = await IMServices.logs.getLogPathsForConversation(
    message.conversation
  );
  signal?.throwIfAborted();
  const changed = [];
  for (const filePath of [...(paths ?? [])]) {
    signal?.throwIfAborted();
    if (await redactLog(filePath, remoteId, signal)) {
      changed.push(filePath);
    }
  }
  signal?.throwIfAborted();
  return changed;
}

/**
 * Hashes exact UTF-8 source bytes for a captured logger version.
 *
 * @param {Uint8Array} bytes - Existing file or record bytes.
 * @returns {string} Lower-case SHA-256 digest.
 */
function privacyDigest(bytes) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(hash.SHA256);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), c =>
    c.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Builds a replacement for the exact stored record versions in a receipt.
 * Later records that reuse the remote ID stay unchanged.
 *
 * @param {{bytes: Uint8Array, target: {records: object[]}}} snapshot -
 *   Current source verified by the logger receipt reader.
 * @param {{remoteId: string}} receipt - Validated stored privacy identity.
 * @returns {{text: string, changed: boolean}} Replacement and whether it erases text.
 * @throws {Error} If a captured record changed or its erased projection differs.
 */
function privacyReplacement(snapshot, receipt) {
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(snapshot.bytes)
    .split("\n");
  const encoder = new TextEncoder();
  let changed = false;
  for (const record of snapshot.target.records) {
    const line = lines[record.line];
    if (typeof line != "string") {
      throw new Error("Captured chat privacy record is missing");
    }
    const digest = privacyDigest(encoder.encode(line));
    if (digest === record.erasedSha256) {
      continue;
    }
    if (digest !== record.beforeSha256) {
      throw new Error("Captured chat privacy record changed");
    }
    const value = JSON.parse(line);
    if (value.remoteId !== receipt.remoteId || !Array.isArray(value.flags)) {
      throw new Error("Captured chat privacy identity changed");
    }
    value.text = "";
    if (!value.flags.includes("deleted")) {
      value.flags.push("deleted");
    }
    const erased = JSON.stringify(value);
    if (privacyDigest(encoder.encode(erased)) !== record.erasedSha256) {
      throw new Error("Captured chat privacy projection changed");
    }
    lines[record.line] = erased;
    changed = true;
  }
  return { text: lines.join("\n"), changed };
}

/**
 * Checks whether a completed receipt's captured versions reappeared.
 * This check does not authorize unknown history or write source bytes.
 *
 * @param {{id: string, remoteId: string, targets: object[]}} receipt - Stored receipt.
 * @param {object} [options={}] - Existing source cancellation control.
 * @param {AbortSignal} [options.signal] - Cancels before queued reads.
 * @returns {Promise<boolean>} Whether a captured, non-erased version remains.
 * @throws {Error} Original cancellation, source or receipt verification error.
 */
export async function chatSearchPrivacyNeedsErasure(receipt, { signal } = {}) {
  let changed = false;
  for (const target of receipt.targets) {
    signal?.throwIfAborted();
    const snapshot = await readChatPrivacyTarget(
      receipt.id,
      target.relativePath,
      {
        signal,
      }
    );
    if (!snapshot.missing) {
      const replacement = privacyReplacement(snapshot, receipt);
      changed = replacement.changed || changed;
    }
  }
  return changed;
}

/**
 * Erases only the captured versions, retaining every unrelated source line.
 * Already-erased or absent targets are still returned for cache erasure on replay.
 * Each file is rechecked inside its write queue; earlier writes are not rolled
 * back if a later file or the destination index fails.
 *
 * @param {{id: string, remoteId: string, targets: object[]}} receipt - Stored receipt.
 * @param {object} [options={}] - Source cancellation control.
 * @param {AbortSignal} [options.signal] - Cancels before starting a source write.
 * @returns {Promise<string[]>} All verified target paths, including unchanged ones.
 * @throws {Error} Original I/O/cancellation or changed-source verification error.
 */
export async function applyChatSearchPrivacyReceipt(receipt, { signal } = {}) {
  const paths = [];
  for (const target of receipt.targets) {
    signal?.throwIfAborted();
    const snapshot = await readChatPrivacyTarget(
      receipt.id,
      target.relativePath,
      {
        signal,
      }
    );
    await queueFileOperation(snapshot.path, async () => {
      signal?.throwIfAborted();
      if (snapshot.missing) {
        try {
          await IOUtils.stat(snapshot.path);
        } catch (error) {
          if (error.name == "NotFoundError") {
            return;
          }
          throw error;
        }
        throw new Error("Chat source reappeared before privacy completion");
      }
      const bytes = await IOUtils.read(snapshot.path);
      if (privacyDigest(bytes) !== snapshot.revision) {
        throw new Error("Chat source changed before privacy erasure");
      }
      const replacement = privacyReplacement({ ...snapshot, bytes }, receipt);
      if (replacement.changed) {
        signal?.throwIfAborted();
        await IOUtils.writeUTF8(snapshot.path, replacement.text, {
          tmpPath: snapshot.path + ".panorama-redaction.tmp",
          flush: true,
        });
      }
    });
    paths.push(snapshot.path);
  }
  return paths;
}
