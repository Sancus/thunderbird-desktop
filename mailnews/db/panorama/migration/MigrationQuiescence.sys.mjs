/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";

const snapshotOperations = new WeakMap();

const SERVER_TYPES = new Set(["none", "imap", "pop3", "nntp", "rss"]);
const STORE_TYPES = new Set([
  "@mozilla.org/msgstore/berkeleystore;1",
  "@mozilla.org/msgstore/maildirstore;1",
]);

/**
 * @typedef {object} MigrationRootDescriptor
 * @property {string} role - Profile, local-profile, message-store or metadata.
 * @property {string|null} pref - Persisted path preference, if any.
 * @property {string|null} descriptor - Unmodified persisted descriptor.
 * @property {string} originalPath - Resolved original path spelling.
 * @property {string} canonicalPath - Normalized path after rejecting links.
 * @property {string} kind - Directory or file; a metadata file may be absent.
 * @property {boolean} exists - Whether this path currently exists.
 * @property {string} parentPath - Existing canonical parent directory.
 * @property {string|null} serverKey - Original server branch, if any.
 */

/**
 * Reads all persisted server paths without constructing accounts or servers.
 * Keeps the selected local profile and external NNTP metadata separately.
 * These descriptors do not confer a native lock, physical custody or permission
 * to copy sources. The native selected-view owner must admit every descriptor.
 *
 * @param {string} profilePath - Actual selected XRE profile directory.
 * @param {string} localProfilePath - Actual selected XRE local directory.
 * @returns {{roots: MigrationRootDescriptor[], servers: object[],
 *   accounts: object[], outgoing: object[]}} Original path and account mappings.
 * @throws {Error} For an unsupported, missing, ambiguous or linked source.
 */
export function collectSelectedMigrationInventory(
  profilePath,
  localProfilePath
) {
  const roots = [
    describePath(profilePath, "directory", "profile"),
    describePath(localProfilePath, "directory", "local-profile"),
  ];
  const selected = { ProfD: profilePath, ProfLD: localProfilePath };
  const serverKeys = new Set();
  for (const name of Services.prefs.getChildList("mail.server.")) {
    const match = /^mail\.server\.([^.]+)\./.exec(name);
    if (match && match[1] != "default") {
      serverKeys.add(match[1]);
    }
  }
  const accounts = [];
  const accountKeys = new Set(
    readString("mail.accountmanager.accounts", "").split(",").filter(Boolean)
  );
  for (const name of Services.prefs.getChildList("mail.account.")) {
    const match = /^mail\.account\.([^.]+)\./.exec(name);
    if (match) {
      accountKeys.add(match[1]);
    }
  }
  for (const key of [...accountKeys].sort()) {
    checkKey(key);
    const server = readString(`mail.account.${key}.server`);
    checkKey(server);
    if (!serverKeys.has(server)) {
      throw new Error("Migration account refers to a missing server branch");
    }
    accounts.push({
      key,
      server,
      identities: readString(`mail.account.${key}.identities`, ""),
    });
  }
  const servers = [];
  for (const key of [...serverKeys].sort()) {
    checkKey(key);
    const branch = `mail.server.${key}`;
    const type = readString(branch + ".type");
    if (!SERVER_TYPES.has(type)) {
      throw new Error("Unsupported migration server type");
    }
    const store = readString(
      branch + ".storeContractID",
      "@mozilla.org/msgstore/berkeleystore;1"
    );
    if (!STORE_TYPES.has(store)) {
      throw new Error("Unsupported migration message store");
    }
    const directory = readPath(branch + ".directory", selected);
    roots.push({
      ...describePath(directory.path, "directory", "message-store"),
      pref: directory.pref,
      descriptor: directory.descriptor,
      serverKey: key,
    });
    const server = { key, type, store, directory: directory.path };
    if (type == "nntp") {
      // These are the real server-pref names, including mail.newsrc_root.
      // A folder URI is never treated as an OS pathname.
      for (const suffix of ["newsrc.file", "mail.newsrc_root"]) {
        const name = branch + "." + suffix;
        const path = readPath(
          suffix == "mail.newsrc_root" && !hasPath(name)
            ? "mail.root.nntp"
            : name,
          selected
        );
        roots.push({
          ...describePath(
            path.path,
            suffix == "newsrc.file" ? "file" : "directory",
            "metadata"
          ),
          pref: path.pref,
          descriptor: path.descriptor,
          serverKey: key,
        });
      }
      // The persisted NNTP fallback root may differ from the server directory.
      if (hasPath("mail.root.nntp")) {
        const path = readPath("mail.root.nntp", selected);
        roots.push({
          ...describePath(path.path, "directory", "metadata"),
          pref: path.pref,
          descriptor: path.descriptor,
          serverKey: key,
        });
      }
    }
    servers.push(server);
  }
  const outgoing = Services.prefs
    .getChildList("mail.smtp")
    .concat(Services.prefs.getChildList("mail.identity."))
    .sort()
    .map(name => ({
      name,
      type: Services.prefs.getPrefType(name),
      value: prefValue(name),
    }));
  const spellings = new Map();
  for (const root of roots) {
    const previous = spellings.get(root.canonicalPath);
    if (previous !== undefined && previous !== root.originalPath) {
      throw new Error("Migration roots use ambiguous path aliases");
    }
    spellings.set(root.canonicalPath, root.originalPath);
  }
  const profile = new FileUtils.File(roots[0].canonicalPath);
  for (const root of roots.slice(1)) {
    const file = new FileUtils.File(root.canonicalPath);
    if (!file.equals(profile) && file.contains(profile)) {
      throw new Error("External migration root contains the selected profile");
    }
  }
  return { roots, servers, accounts, outgoing };
}

/**
 * Resolves a persisted relative-first path against the actual XRE directories.
 * Never asks the directory service to choose a profile or repairs a preference.
 *
 * @param {string} name - Absolute path preference without the -rel suffix.
 * @param {Record<string, string>} selected - Explicit ProfD and ProfLD values.
 * @returns {{path: string, pref: string, descriptor: string}} Original selection.
 */
function readPath(name, selected) {
  const relative = name + "-rel";
  if (Services.prefs.getPrefType(relative) != Ci.nsIPrefBranch.PREF_INVALID) {
    const descriptor = readString(relative);
    const match = /^\[(ProfD|ProfLD)\](.*)$/.exec(descriptor);
    if (!match || !match[2] || match[2].includes("\0")) {
      throw new Error("Invalid relative migration path descriptor");
    }
    const parts = match[2].split(/[\\/]/);
    if (parts.some(part => !part || part == "." || part == "..")) {
      throw new Error("Invalid relative migration path component");
    }
    const file = new FileUtils.File(selected[match[1]]);
    for (const part of parts) {
      file.append(part);
    }
    return { path: file.path, pref: relative, descriptor };
  }
  const descriptor = readString(name);
  if (
    !descriptor ||
    descriptor.includes("\0") ||
    !PathUtils.isAbsolute(descriptor)
  ) {
    throw new Error("Invalid absolute migration path descriptor");
  }
  return { path: descriptor, pref: name, descriptor };
}

/**
 * Returns whether either persisted spelling exists, including malformed values.
 *
 * @param {string} name - Absolute preference name.
 * @returns {boolean} Whether the path is configured.
 */
function hasPath(name) {
  return [name, name + "-rel"].some(
    key => Services.prefs.getPrefType(key) != Ci.nsIPrefBranch.PREF_INVALID
  );
}

/**
 * Rejects links in every component before normalizing a literal source path.
 * Only an external metadata file may be absent; its existing parent is retained.
 *
 * @param {string} path - Original absolute path.
 * @param {string} kind - Directory or file.
 * @param {string} role - Source role recorded in the returned descriptor.
 * @returns {MigrationRootDescriptor} Metadata requiring native custody.
 */
function describePath(path, kind, role) {
  if (
    typeof path != "string" ||
    path.includes("\0") ||
    !PathUtils.isAbsolute(path) ||
    path.split(/[\\/]/).some(part => part == "." || part == "..")
  ) {
    throw new Error("Invalid migration source path");
  }
  const file = new FileUtils.File(path);
  const exists = file.exists();
  if (!exists && kind != "file") {
    throw new Error("Missing migration source directory");
  }
  for (let part = file; part; part = part.parent) {
    let link;
    try {
      link = part.isSymlink();
    } catch (error) {
      if (
        exists ||
        !part.equals(file) ||
        error.result != Cr.NS_ERROR_FILE_NOT_FOUND
      ) {
        throw error;
      }
    }
    if (link) {
      throw new Error("Migration source path contains a link");
    }
    if (!part.equals(file) && !part.isDirectory()) {
      throw new Error("Migration source parent is not a directory");
    }
  }
  if (exists && (kind == "directory" ? !file.isDirectory() : !file.isFile())) {
    throw new Error("Unsupported migration source type");
  }
  const parent = file.parent;
  if (!parent) {
    throw new Error("Migration source cannot be a filesystem root");
  }
  parent.normalize();
  const canonical = exists ? file.clone() : parent.clone();
  if (exists) {
    canonical.normalize();
  } else {
    canonical.append(file.leafName);
  }
  return {
    role,
    pref: null,
    descriptor: null,
    originalPath: path,
    canonicalPath: canonical.path,
    kind,
    exists,
    parentPath: parent.path,
    serverKey: null,
  };
}

/**
 * Reads a string preference without converting a wrong type or writing defaults.
 *
 * @param {string} name - Preference name.
 * @param {string} [fallback] - Used only when the preference is absent.
 * @returns {string} Persisted value or the explicit absent fallback.
 */
function readString(name, fallback) {
  const type = Services.prefs.getPrefType(name);
  if (type == Ci.nsIPrefBranch.PREF_INVALID && fallback !== undefined) {
    return fallback;
  }
  if (type != Ci.nsIPrefBranch.PREF_STRING) {
    throw new Error("Missing or non-string migration preference: " + name);
  }
  return Services.prefs.getStringPref(name);
}

/**
 * Reads a literal configured preference without constructing a protocol service.
 *
 * @param {string} name - Existing preference name.
 * @returns {string|number|boolean} Original typed value.
 */
function prefValue(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Ci.nsIPrefBranch.PREF_STRING:
      return Services.prefs.getStringPref(name);
    case Ci.nsIPrefBranch.PREF_INT:
      return Services.prefs.getIntPref(name);
    case Ci.nsIPrefBranch.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    default:
      throw new Error("Unknown migration preference type");
  }
}

/**
 * Rejects ambiguous branch identifiers without normalizing their spelling.
 *
 * @param {string} key - Persisted account or server branch identifier.
 */
function checkKey(key) {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error("Invalid migration account or server key");
  }
}

/**
 * Checks the actual native selected view before accessing snapshot sources.
 * A process admission subject or a copied property bag cannot grant this lease.
 *
 * @param {nsISupports} nativeView - Borrowed view minted by the native XRE owner.
 * @param {string} phase - before-source-read, after-await or before-publication.
 * @throws {nsIException} If selection, ownership, generation or phase is invalid.
 */
export function validateSelectedMigrationView(nativeView, phase) {
  if (!nativeView) {
    throw Components.Exception(
      "Snapshot requires its native selected-profile view",
      Cr.NS_ERROR_NOT_AVAILABLE
    );
  }
  if (
    !["before-source-read", "after-await", "before-publication"].includes(phase)
  ) {
    throw Components.Exception(
      "Invalid snapshot phase",
      Cr.NS_ERROR_INVALID_ARG
    );
  }
  Cc["@mozilla.org/mailnews/migration-writer-lease;1"]
    .getService(Ci.nsIObserver)
    .observe(nativeView, "validate-selected-view", phase);
}

/**
 * Retains one actual IO promise through settlement under the native selection.
 * Existing quiesced-backup callers without a view retain their original path;
 * the selected snapshot caller must always supply its actual borrowed view.
 *
 * @param {nsISupports|undefined} nativeView - Exact native selected view.
 * @param {function(): Promise<unknown>} operation - Starts IO after validation.
 * @returns {Promise<unknown>} The actual IO result after native revalidation.
 * @throws {*} The original IO rejection, or native validation failure.
 */
export async function selectedMigrationIO(nativeView, operation) {
  if (!nativeView) {
    return operation();
  }
  validateSelectedMigrationView(nativeView, "before-source-read");
  await checkSnapshotCancellation(nativeView);
  let result;
  try {
    result = await operation();
  } catch (error) {
    try {
      validateSelectedMigrationView(nativeView, "after-await");
    } catch (secondary) {
      // Keep the IO rejection object/result as primary. The native gate already
      // retains its own error; this separate diagnostic must not replace IO.
      Cu.reportError(secondary);
    }
    throw error;
  }
  validateSelectedMigrationView(nativeView, "after-await");
  await checkSnapshotCancellation(nativeView);
  return result;
}

/**
 * Runs the actual pre-app-startup snapshot while native code retains its leases.
 * Request paths compare the native selection; they never supply source roots or
 * permission. Resolves only after copied bytes, snapshot journal and consumer
 * receipt are durable. Native code alone settles/releases participants next.
 * A snapshot journal is not an import/activation-stage MigrationJournal.
 *
 * @param {nsISupports} nativeView - Borrowed native selected-profile view.
 * @param {AbortSignal} signal - Native cancellation signal.
 * @param {string} requestPath - Exact absolute native command-line argument.
 * @returns {Promise<void>} Verified consumer settlement, not native release.
 * @throws {*} Original IO/native/cancellation rejection after owned IO settles.
 */
export async function runSelectedProfileSnapshot(
  nativeView,
  signal,
  requestPath
) {
  validateSelectedMigrationView(nativeView, "before-source-read");
  if (snapshotOperations.has(nativeView)) {
    throw Components.Exception(
      "Reentrant selected snapshot",
      Cr.NS_ERROR_IN_PROGRESS
    );
  }
  const bag = nativeView.QueryInterface(Ci.nsIPropertyBag2);
  const profilePath = bag.getPropertyAsAString("profile-path");
  const localPath = bag.getPropertyAsAString("local-path");
  if (requestPath !== bag.getPropertyAsAString("request-path")) {
    throw new Error("Snapshot request is not the native selected request");
  }
  const inventory = JSON.parse(bag.getPropertyAsAString("inventory-json"));
  assertSelectedInventory(inventory, profilePath, localPath);
  assertOutsideSources(requestPath, inventory, "file");
  const request = await selectedMigrationIO(nativeView, () =>
    IOUtils.readJSON(requestPath)
  );
  const keys = [
    "version",
    "operationId",
    "profilePath",
    "localProfilePath",
    "backupPath",
    "journalPath",
    "resultPath",
  ];
  if (
    !request ||
    Array.isArray(request) ||
    request.version !== 1 ||
    Object.keys(request).some(key => ![...keys, "cancelPath"].includes(key)) ||
    keys.some(key => !Object.hasOwn(request, key)) ||
    typeof request.operationId != "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.operationId) ||
    request.profilePath !== profilePath ||
    request.localProfilePath !== localPath
  ) {
    throw new Error("Invalid selected snapshot request or comparison paths");
  }
  const progressPath = request.resultPath + ".progress";
  const paths = [
    requestPath,
    request.backupPath,
    request.journalPath,
    request.resultPath,
    progressPath,
  ];
  if (request.cancelPath !== undefined) {
    paths.push(request.cancelPath);
  }
  paths.push(
    request.journalPath + ".tmp",
    request.resultPath + ".tmp",
    progressPath + ".tmp"
  );
  const files = paths.map((path, index) =>
    assertOutsideSources(path, inventory, index == 1 ? "directory" : "file")
  );
  for (const [i, file] of files.entries()) {
    if (i && file.exists()) {
      throw new Error(
        "Snapshot output/control already exists; preserve previous operation"
      );
    }
    if (
      files.some(
        (other, j) =>
          j != i &&
          (file.equals(other) || file.contains(other) || other.contains(file))
      )
    ) {
      throw new Error("Snapshot request/output paths overlap");
    }
  }
  if (
    request.cancelPath &&
    !new FileUtils.File(request.cancelPath).parent.equals(
      new FileUtils.File(request.resultPath).parent
    )
  ) {
    throw new Error(
      "Snapshot cancellation must use the controlled result directory"
    );
  }
  const context = {
    nativeView,
    signal,
    request,
    inventory,
    progressPath,
    generation: bag.getPropertyAsUint64("generation"),
    copy: null,
    cancellation: null,
    backup: null,
    checkingCancel: false,
    journalCreated: false,
    secondaryErrors: [],
  };
  snapshotOperations.set(nativeView, context);
  try {
    await writeSnapshotRecord(
      context,
      request.journalPath,
      {
        ...snapshotIdentity(context),
        state: "SNAPSHOT_PENDING",
        backup: null,
      },
      true
    );
    context.journalCreated = true;
    const { createSelectedMigrationBackup } = ChromeUtils.importESModule(
      "resource:///modules/panorama/MigrationBackup.sys.mjs"
    );
    context.backup = await createSelectedMigrationBackup(
      inventory,
      request.backupPath,
      signal,
      nativeView
    );
    assertSelectedInventory(inventory, profilePath, localPath);
    await checkSnapshotCancellation(nativeView);
    validateSelectedMigrationView(nativeView, "before-publication");
    const receipt = {
      ...snapshotIdentity(context),
      state: "CONSUMER_VERIFIED",
      backup: context.backup,
      nativeRelease: "PENDING",
      copy: context.copy,
    };
    await writeSnapshotRecord(context, request.journalPath, receipt);
    await checkSnapshotCancellation(nativeView);
    // The final consumer receipt follows the last cancellation boundary. Its
    // durable write still joins actual IO and native identity validation; a
    // completed consumer is not retroactively rejected by a later control file.
    await writeSnapshotRecord(context, request.resultPath, receipt, true);
  } catch (error) {
    // Every issued operation above is awaited. These diagnostic writes also
    // settle before rejecting; a completed backup remains intact on later error.
    const failure = {
      ...snapshotIdentity(context),
      state: "CONSUMER_FAILED",
      nativeRelease: "PENDING",
      error: snapshotError(error),
      secondaryErrors: context.secondaryErrors,
      backup: context.backup,
      copy: context.copy,
      cancellation: context.cancellation,
    };
    for (const path of [
      context.journalCreated ? request.journalPath : null,
      request.resultPath,
    ].filter(Boolean)) {
      try {
        await writeSnapshotRecord(
          context,
          path,
          failure,
          path == request.resultPath,
          true
        );
      } catch (secondary) {
        context.secondaryErrors.push(snapshotError(secondary));
        Cu.reportError(secondary);
      }
    }
    throw error;
  } finally {
    snapshotOperations.delete(nativeView);
  }
}

/**
 * Copies one real source file, retaining its promise even if progress IO fails.
 * Progress reports actual callback times. It never delays the copy or declares
 * cancellation/release complete. Without a selected view, normal backup copy
 * behavior is unchanged.
 *
 * @param {nsISupports|undefined} nativeView - Actual selected view, if present.
 * @param {string} source - Source file path.
 * @param {string} target - Destination path.
 * @param {object} [options] - IOUtils.copy options.
 * @returns {Promise<void>} Actual copy and progress IO settlement.
 */
export async function selectedMigrationCopy(
  nativeView,
  source,
  target,
  options = {}
) {
  const context = nativeView && snapshotOperations.get(nativeView);
  if (!context) {
    return selectedMigrationIO(nativeView, () =>
      IOUtils.copy(source, target, options)
    );
  }
  return selectedMigrationIO(nativeView, async () => {
    const copy = { source, target, started: Date.now(), settled: null };
    let failureOrder = 0;
    // Attach a rejection handler immediately, before awaiting progress IO.
    const pending = IOUtils.copy(source, target, options).then(
      () => {
        copy.settled = Date.now();
        return null;
      },
      error => {
        copy.settled = Date.now();
        return { error, time: copy.settled, order: ++failureOrder };
      }
    );
    let diagnosticError;
    try {
      await writeSnapshotRecord(context, context.progressPath, {
        ...snapshotIdentity(context),
        state: "COPY_PENDING",
        copy,
      });
    } catch (error) {
      diagnosticError = { error, time: Date.now(), order: ++failureOrder };
    }
    const copyError = await pending;
    context.copy = copy;
    const errors = [copyError, diagnosticError]
      .filter(Boolean)
      .sort((a, b) => a.order - b.order);
    if (errors.length) {
      context.secondaryErrors.push(
        ...errors.slice(1).map(item => snapshotError(item.error))
      );
      throw errors[0].error;
    }
    await writeSnapshotRecord(context, context.progressPath, {
      ...snapshotIdentity(context),
      state: "COPY_SETTLED",
      copy,
    });
  });
}

/**
 * Checks an operation-bound cancellation at a natural asynchronous boundary.
 * This never abandons already-issued IO or polls for another task to finish.
 *
 * @param {nsISupports} nativeView - Exact selected view.
 * @returns {Promise<void>} Resolves when no cancellation has been requested.
 */
async function checkSnapshotCancellation(nativeView) {
  const context = snapshotOperations.get(nativeView);
  if (!context || context.checkingCancel) {
    return;
  }
  if (context.signal?.aborted) {
    throw (
      context.signal.reason ??
      Components.Exception("Snapshot cancelled", Cr.NS_ERROR_ABORT)
    );
  }
  if (!context.request.cancelPath) {
    return;
  }
  context.checkingCancel = true;
  try {
    const path = context.request.cancelPath;
    const exists = await snapshotControlIO(context, () => IOUtils.exists(path));
    if (!exists) {
      return;
    }
    assertOutsideSources(path, context.inventory, "file");
    const stat = await snapshotControlIO(context, () => IOUtils.stat(path));
    const cancel = await snapshotControlIO(context, () =>
      IOUtils.readJSON(path)
    );
    if (
      stat.type != "regular" ||
      cancel?.operationId !== context.request.operationId ||
      Object.keys(cancel).length !== 1
    ) {
      throw new Error("Invalid or foreign snapshot cancellation");
    }
    context.cancellation = {
      observed: Date.now(),
      modified: stat.lastModified,
    };
    throw Components.Exception(
      "Selected snapshot cancelled",
      Cr.NS_ERROR_ABORT
    );
  } finally {
    context.checkingCancel = false;
  }
}

/**
 * Compares live persisted descriptors with all native-bound inventory fields.
 *
 * @param {object} inventory - Native inventory with physical identity strings.
 * @param {string} profilePath - Actual XRE profile.
 * @param {string} localPath - Actual XRE local directory.
 * @throws {Error} When a descriptor, selected path or physical binding is absent.
 */
function assertSelectedInventory(inventory, profilePath, localPath) {
  const current = collectSelectedMigrationInventory(profilePath, localPath);
  if (
    !Array.isArray(inventory?.roots) ||
    inventory.roots.some(
      root =>
        typeof root.nativePhysicalIdentity != "string" ||
        typeof root.nativeParentIdentity != "string" ||
        !root.nativeParentIdentity ||
        (root.exists && !root.nativePhysicalIdentity)
    )
  ) {
    throw new Error("Snapshot inventory lacks native physical custody");
  }
  const plain = {
    ...inventory,
    roots: inventory.roots.map(
      ({ nativePhysicalIdentity, nativeParentIdentity, ...root }) => root
    ),
  };
  if (JSON.stringify(current) !== JSON.stringify(plain)) {
    throw new Error("Selected snapshot descriptors changed");
  }
}

/**
 * Validates a controlled request/output path outside every selected source.
 * A selected metadata parent is also excluded, so diagnostics cannot mutate it.
 *
 * @param {string} path - Absolute path with an existing physical parent.
 * @param {object} inventory - Native selected roots.
 * @param {string} kind - Expected directory or regular file, if present.
 * @returns {nsIFile} Checked literal path.
 */
function assertOutsideSources(path, inventory, kind) {
  const descriptor = describePath(path, "file", "control");
  const file = new FileUtils.File(descriptor.canonicalPath);
  if (
    file.exists() &&
    (kind == "directory" ? !file.isDirectory() : !file.isFile())
  ) {
    throw new Error("Invalid snapshot control/output type");
  }
  for (const root of inventory.roots) {
    const source = new FileUtils.File(
      root.kind == "file" ? root.parentPath : root.canonicalPath
    );
    if (source.equals(file) || source.contains(file) || file.contains(source)) {
      throw new Error("Snapshot request/output overlaps selected sources");
    }
  }
  return file;
}

/**
 * Writes one controlled durable snapshot record without releasing native custody.
 * Cleanup uses identity validation, not permission to start another source read.
 *
 * @param {object} context - Current selected operation.
 * @param {string} path - Already admitted controlled output path.
 * @param {object} value - JSON receipt or diagnostic.
 * @param {boolean} [create=false] - Refuse an existing output.
 * @param {boolean} [cleanup=false] - Preserve original failure during diagnostics.
 * @returns {Promise<void>} Actual durable write settlement.
 */
async function writeSnapshotRecord(
  context,
  path,
  value,
  create = false,
  cleanup = false
) {
  assertOutsideSources(path, context.inventory, "file");
  assertOutsideSources(path + ".tmp", context.inventory, "file");
  validateSelectedMigrationView(
    context.nativeView,
    cleanup ? "after-await" : "before-publication"
  );
  await snapshotControlIO(context, () =>
    IOUtils.writeJSON(path, value, {
      ...(create ? { mode: "create" } : { tmpPath: path + ".tmp" }),
      flush: true,
    })
  );
}

/** @param {object} context - Selected operation. @returns {object} Receipt identity. */
function snapshotIdentity(context) {
  return {
    version: 1,
    kind: "selected-profile-snapshot-journal",
    operationId: context.request.operationId,
    profilePath: context.request.profilePath,
    localProfilePath: context.request.localProfilePath,
    generation: context.generation,
    pid: Services.appinfo.processID,
  };
}

/** @param {*} error - Original rejection. @returns {object} Diagnostic only. */
function snapshotError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    result: error?.result ?? null,
  };
}

/**
 * Retains controlled output/cancel IO and checks identity after either outcome.
 * The after-await phase grants no permission to start source work or release.
 *
 * @param {object} context - Current operation and separate secondary errors.
 * @param {function(): Promise<unknown>} operation - Actual controlled IO.
 * @returns {Promise<unknown>} Original IO result after identity validation.
 * @throws {*} Original IO error; secondary identity failure stays separate.
 */
async function snapshotControlIO(context, operation) {
  validateSelectedMigrationView(context.nativeView, "after-await");
  let value;
  try {
    value = await operation();
  } catch (error) {
    try {
      validateSelectedMigrationView(context.nativeView, "after-await");
    } catch (secondary) {
      context.secondaryErrors.push(snapshotError(secondary));
      Cu.reportError(secondary);
    }
    throw error;
  }
  validateSelectedMigrationView(context.nativeView, "after-await");
  return value;
}
