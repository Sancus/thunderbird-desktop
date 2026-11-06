/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const {
  collectSelectedMigrationInventory,
  validateSelectedMigrationView,
  selectedMigrationIO,
  runSelectedProfileSnapshot,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationQuiescence.sys.mjs"
);

const { createMigrationBackup, verifySelectedMigrationBackup } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MigrationBackup.sys.mjs"
  );
const { hashMigrationFile } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MigrationSource.sys.mjs"
);

/**
 * Creates real roots and restores only the preferences this test changes.
 * No account, server, search or logger service is created by this fixture.
 *
 * @param {function(object): Promise<void>} body - Assertions on the real paths.
 * @returns {Promise<void>} Resolves after preferences and files are restored.
 */
async function withInventoryFixture(body) {
  const root = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "migration-inventory-"
  );
  registerCleanupFunction(() =>
    IOUtils.remove(root, { recursive: true, ignoreAbsent: true })
  );
  const profile = PathUtils.join(root, "profile");
  const local = PathUtils.join(root, "local-profile");
  const mail = PathUtils.join(root, "external-mail");
  const news = PathUtils.join(root, "external-news");
  for (const path of [profile, local, mail, news]) {
    await IOUtils.makeDirectory(path);
  }
  const values = new Map();
  function setPref(name, value) {
    if (!values.has(name)) {
      values.set(name, {
        user: Services.prefs.prefHasUserValue(name),
        value: Services.prefs.prefHasUserValue(name)
          ? Services.prefs.getStringPref(name)
          : null,
      });
    }
    Services.prefs.setStringPref(name, value);
  }
  const key =
    "migrationInventory" +
    Services.uuid
      .generateUUID()
      .toString()
      .replace(/[^a-zA-Z0-9]/g, "");
  const branch = `mail.server.${key}`;
  setPref(branch + ".type", "none");
  setPref(branch + ".directory", mail);
  const beforeNSS = ["cert9.db", "key4.db", "pkcs11.txt"];
  try {
    await body({ root, profile, local, mail, news, key, branch, setPref });
    for (const name of beforeNSS) {
      Assert.ok(
        !(await IOUtils.exists(PathUtils.join(profile, name))),
        "Inventory did not initialize writable profile NSS: " + name
      );
    }
  } finally {
    for (const [name, previous] of values) {
      if (previous.user) {
        Services.prefs.setStringPref(name, previous.value);
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
    await IOUtils.remove(root, { recursive: true });
  }
}

add_task(function test_snapshotRefusesMissingNativeAuthorityBeforeRead() {
  Assert.throws(
    () => validateSelectedMigrationView(null, "before-source-read"),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "A missing native view cannot permit a source read"
  );
});

add_task(function test_snapshotRefusesForeignNativeSubjectBeforeRead() {
  const gate = Cc["@mozilla.org/mailnews/migration-writer-lease;1"].getService(
    Ci.nsIObserver
  );
  const processSubject = gate
    .QueryInterface(Ci.nsIPropertyBag2)
    .getPropertyAsInterface("writer-admission-subject", Ci.nsISupports);
  Assert.throws(
    () => validateSelectedMigrationView(processSubject, "before-source-read"),
    error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
    "A genuine process admission subject is not the selected-profile view"
  );
});

add_task(async function test_inventoryPreservesOriginalRootDescriptors() {
  await withInventoryFixture(async f => {
    const relativeName = "mail-\u90ae\u4ef6-e\u0301";
    const relativePath = PathUtils.join(f.profile, relativeName);
    await IOUtils.makeDirectory(relativePath);
    const descriptor = "[ProfD]" + relativeName;
    f.setPref(f.branch + ".directory-rel", descriptor);
    const inventory = collectSelectedMigrationInventory(f.profile, f.local);
    const source = inventory.roots.find(
      item => item.serverKey == f.key && item.role == "message-store"
    );
    Assert.ok(source, "The persisted orphan server is inventoried");
    Assert.equal(source.descriptor, descriptor);
    Assert.equal(source.originalPath, relativePath);
    Assert.equal(source.pref, f.branch + ".directory-rel");
    Assert.equal(Services.prefs.getStringPref(f.branch + ".directory"), f.mail);
    Assert.equal(Services.prefs.getStringPref(source.pref), descriptor);
    Assert.equal(inventory.roots[0].originalPath, f.profile);
    Assert.equal(inventory.roots[1].originalPath, f.local);
    Assert.notEqual(
      inventory.roots[0].canonicalPath,
      inventory.roots[1].canonicalPath
    );
  });
});

add_task(
  async function test_inventoryIncludesDistinctLocalAndExternalNewsMetadata() {
    await withInventoryFixture(async f => {
      const leaf = PathUtils.join(f.news, "original-newsrc");
      await IOUtils.writeUTF8(leaf, "mozilla.test: 1-3\n");
      f.setPref(f.branch + ".type", "nntp");
      f.setPref(f.branch + ".newsrc.file", leaf);
      f.setPref(f.branch + ".mail.newsrc_root", f.news);
      const inventory = collectSelectedMigrationInventory(f.profile, f.local);
      const metadata = inventory.roots.filter(
        item => item.serverKey == f.key && item.role == "metadata"
      );
      Assert.ok(
        metadata.some(
          item =>
            item.originalPath == leaf && item.kind == "file" && item.exists
        )
      );
      Assert.ok(
        metadata.some(
          item => item.originalPath == f.news && item.kind == "directory"
        )
      );
      Assert.equal(await IOUtils.readUTF8(leaf), "mozilla.test: 1-3\n");
      Assert.equal(
        Services.prefs.getStringPref(f.branch + ".newsrc.file"),
        leaf
      );
      const absent = PathUtils.join(f.news, "not-created-newsrc");
      f.setPref(f.branch + ".newsrc.file", absent);
      const missing = collectSelectedMigrationInventory(
        f.profile,
        f.local
      ).roots.find(item => item.originalPath == absent);
      Assert.ok(
        missing,
        "The absent configured metadata leaf is not silently dropped"
      );
      Assert.equal(missing.exists, false);
      Assert.equal(missing.parentPath, new FileUtils.File(f.news).path);
      Assert.ok(
        !(await IOUtils.exists(absent)),
        "Inventory did not create a metadata file"
      );
    });
  }
);

add_task(
  async function test_inventoryRejectsMalformedRelativeOrUnknownOwnership() {
    await withInventoryFixture(async f => {
      f.setPref(f.branch + ".directory-rel", "[ProfD]../outside");
      Assert.throws(
        () => collectSelectedMigrationInventory(f.profile, f.local),
        /Invalid relative migration path/,
        "A malformed present relative path cannot fall back to a valid absolute path"
      );
      f.setPref(f.branch + ".directory-rel", "[Unknown]mail");
      Assert.throws(
        () => collectSelectedMigrationInventory(f.profile, f.local),
        /Invalid relative migration path/
      );
      f.setPref(f.branch + ".directory-rel", "[ProfD]mail");
      await IOUtils.makeDirectory(PathUtils.join(f.profile, "mail"));
      f.setPref(f.branch + ".type", "unowned-protocol");
      Assert.throws(
        () => collectSelectedMigrationInventory(f.profile, f.local),
        /Unsupported migration server type/
      );
      f.setPref(f.branch + ".type", "none");
      f.setPref(
        f.branch + ".storeContractID",
        "@example.invalid/unowned-store;1"
      );
      Assert.throws(
        () => collectSelectedMigrationInventory(f.profile, f.local),
        /Unsupported migration message store/
      );
      Assert.equal(
        Services.prefs.getStringPref(f.branch + ".directory"),
        f.mail
      );
    });
  }
);

add_task(
  async function test_inventoryRejectsOverlapsAliasesAndChangedParents() {
    await withInventoryFixture(async f => {
      f.setPref(f.branch + ".directory", f.root);
      Assert.throws(
        () => collectSelectedMigrationInventory(f.profile, f.local),
        /contains the selected profile/,
        "An external source cannot contain the selected profile"
      );
      f.setPref(f.branch + ".directory", f.mail + "/../external-mail");
      Assert.throws(
        () => collectSelectedMigrationInventory(f.profile, f.local),
        /Invalid migration source path/,
        "A normalized alias cannot replace the literal configured source"
      );
      f.setPref(f.branch + ".directory", f.mail);
      // A parent replaced by a regular file is a real unavailable path, not an
      // empty directory or permission waiver. Native physical replacement during
      // pending IO is separately proved by the real early-child/native tests.
      await IOUtils.remove(f.mail);
      await IOUtils.writeUTF8(f.mail, "replacement");
      Assert.throws(
        () => collectSelectedMigrationInventory(f.profile, f.local),
        /Unsupported migration source type/,
        "A changed directory source is not admitted"
      );
      Assert.equal(await IOUtils.readUTF8(f.mail), "replacement");
    });
  }
);

add_task(async function test_snapshotRefusalPreservesFirstErrorAndOriginals() {
  await withInventoryFixture(async f => {
    const source = PathUtils.join(f.mail, "original");
    await IOUtils.writeUTF8(source, "unchanged original bytes");
    const gate = Cc[
      "@mozilla.org/mailnews/migration-writer-lease;1"
    ].getService(Ci.nsIObserver);
    const subject = gate
      .QueryInterface(Ci.nsIPropertyBag2)
      .getPropertyAsInterface("writer-admission-subject", Ci.nsISupports);
    await Assert.rejects(
      runSelectedProfileSnapshot(subject, undefined, source),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "The real consumer rejects foreign authority before reading a request"
    );
    let started = false;
    await Assert.rejects(
      selectedMigrationIO(subject, async () => {
        started = true;
        await IOUtils.writeUTF8(source, "must not be written");
      }),
      error => error.result == Cr.NS_ERROR_NOT_AVAILABLE,
      "Foreign authority rejects before even starting an IO promise"
    );
    Assert.equal(started, false);
    Assert.equal(await IOUtils.readUTF8(source), "unchanged original bytes");

    // Existing unarmed backup IO remains the ordinary path. A real rejected
    // filesystem promise must retain its original error object, not a later
    // queue/cleanup success. This is not a selected-XRE/Held claim.
    let first;
    await Assert.rejects(
      selectedMigrationIO(undefined, async () => {
        try {
          return await IOUtils.readUTF8(PathUtils.join(f.mail, "missing"));
        } catch (error) {
          first = error;
          throw error;
        }
      }),
      error => error === first && error.name == "NotFoundError",
      "The original actual IO rejection survives promise settlement"
    );
    Assert.equal(await IOUtils.readUTF8(source), "unchanged original bytes");
  });
});

add_task(
  async function test_savedSnapshotRejectsMetadataOmissionAndTampering() {
    await withInventoryFixture(async f => {
      const metadata = PathUtils.join(f.root, "metadata");
      await IOUtils.makeDirectory(metadata);
      const original = PathUtils.join(metadata, "newsrc");
      const bytes = new TextEncoder().encode("mozilla.original: 1-3\n");
      await IOUtils.write(original, bytes, { mode: "create" });
      f.setPref(f.branch + ".type", "nntp");
      f.setPref(f.branch + ".newsrc.file", original);
      f.setPref(f.branch + ".mail.newsrc_root", f.news);
      const inventory = collectSelectedMigrationInventory(f.profile, f.local);
      const bundle = PathUtils.join(f.root, "saved-snapshot");
      await IOUtils.makeDirectory(bundle);
      const directories = await createMigrationBackup(
        f.profile,
        [f.local, f.mail, f.news],
        PathUtils.join(bundle, "directories")
      );
      const files = PathUtils.join(bundle, "files");
      await IOUtils.makeDirectory(files);
      const copy = PathUtils.join(files, "file-0");
      await IOUtils.copy(original, copy, { noOverwrite: true });
      const info = await IOUtils.stat(original);
      // An untrusted saved manifest is data, never a native selected view. This
      // fixture exercises offline copy verification only; real creation/custody
      // and whole Held/release ordering belong to the early-child/native cases.
      const manifest = {
        version: 1,
        kind: "selected-profile-snapshot",
        complete: true,
        inventory,
        directories,
        externalFiles: [
          {
            source: original,
            exists: true,
            file: "file-0",
            size: info.size,
            sha256: await hashMigrationFile(original),
            permissions: info.permissions,
            lastModified: info.lastModified,
          },
        ],
      };
      const path = PathUtils.join(bundle, "snapshot.json");
      await IOUtils.writeJSON(path, manifest, { mode: "create", flush: true });
      const verified = await verifySelectedMigrationBackup(bundle);
      Assert.equal(verified.path, path);
      Assert.equal(verified.sha256, await hashMigrationFile(path));
      await IOUtils.writeUTF8(copy, "corrupt copied metadata\n");
      await Assert.rejects(
        verifySelectedMigrationBackup(bundle),
        /differs from its source/,
        "A directory-only receipt cannot conceal a changed external metadata copy"
      );
      await IOUtils.write(copy, bytes);
      const incomplete = structuredClone(manifest);
      incomplete.externalFiles = [];
      await IOUtils.writeJSON(path, incomplete, { flush: true });
      await Assert.rejects(
        verifySelectedMigrationBackup(bundle),
        /omits selected external metadata/,
        "A saved snapshot must contain every selected external metadata leaf"
      );
      await IOUtils.writeJSON(path, manifest, { flush: true });
      Assert.equal(
        (await verifySelectedMigrationBackup(bundle)).sha256,
        verified.sha256
      );
      Assert.deepEqual(await IOUtils.read(original), bytes);
      Assert.equal(
        Services.prefs.getStringPref(f.branch + ".newsrc.file"),
        original
      );
    });
  }
);
