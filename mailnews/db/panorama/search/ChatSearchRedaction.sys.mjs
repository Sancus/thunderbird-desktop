/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { IMServices } from "resource:///modules/IMServices.sys.mjs";
import {
  encodeName,
  queueFileOperation,
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
