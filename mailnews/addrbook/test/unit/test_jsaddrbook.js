/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var FILE_NAME = "abook-1.sqlite";
var SCHEME = "jsaddrbook";

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

var book, contact, list, listCard;
var observer = {
  topics: [
    "addrbook-directory-created",
    "addrbook-directory-updated",
    "addrbook-directory-deleted",
    "addrbook-contact-created",
    "addrbook-contact-updated",
    "addrbook-contact-properties-updated",
    "addrbook-contact-deleted",
    "addrbook-list-created",
    "addrbook-list-updated",
    "addrbook-list-deleted",
    "addrbook-list-member-added",
    "addrbook-list-member-removed",
  ],
  setUp() {
    for (const topic of this.topics) {
      Services.obs.addObserver(observer, topic);
    }
  },
  cleanUp() {
    for (const topic of this.topics) {
      Services.obs.removeObserver(observer, topic);
    }
  },

  events: [],
  observe(subject, topic, data) {
    this.events.push([topic, subject, data]);
  },
  checkEvents(...events) {
    info(
      "Actual events: " +
        JSON.stringify(
          observer.events.map(e =>
            e.map(a => {
              if (a instanceof Ci.nsIAbDirectory) {
                return `[nsIAbDirectory]`;
              }
              if (a instanceof Ci.nsIAbCard) {
                return `[nsIAbCard]`;
              }
              return a;
            })
          )
        )
    );
    equal(observer.events.length, events.length);

    const actualEvents = observer.events.slice();
    observer.events.length = 0;

    for (let j = 0; j < events.length; j++) {
      const expectedEvent = events[j];
      const actualEvent = actualEvents[j];

      for (let i = 0; i < expectedEvent.length; i++) {
        try {
          expectedEvent[i].QueryInterface(Ci.nsIAbCard);
          ok(actualEvent[i].equals(expectedEvent[i]));
        } catch (ex) {
          if (expectedEvent[i] instanceof Ci.nsIAbDirectory) {
            equal(actualEvent[i].UID, expectedEvent[i].UID);
          } else if (expectedEvent[i] === null) {
            ok(!actualEvent[i]);
          } else if (expectedEvent[i] !== undefined) {
            equal(actualEvent[i], expectedEvent[i]);
          }
        }
      }
    }

    return actualEvents;
  },
};

var baseAddressBookCount;

add_setup(function () {
  const profileDir = do_get_profile();
  observer.setUp();

  const dirs = MailServices.ab.directories;
  // On Mac we might be loading the OS X Address Book. If we are, then we
  // need to take account of that here, so that the test still pass on
  // development machines.
  if (
    AppConstants.platform == "macosx" &&
    dirs[0].URI == "moz-abosxdirectory:///"
  ) {
    equal(dirs.length, 3);
    equal(dirs[1].fileName, kPABData.fileName);
    equal(dirs[2].fileName, kCABData.fileName);
  } else {
    equal(dirs.length, 2);
    equal(dirs[0].fileName, kPABData.fileName);
    equal(dirs[1].fileName, kCABData.fileName);
  }
  // Also record the address book counts so that we get the expected counts
  // correct further down in the test.
  baseAddressBookCount = dirs.length;

  // Check the PAB file was created.
  const pabFile = profileDir.clone();
  pabFile.append(kPABData.fileName);
  ok(pabFile.exists());

  // Check the CAB file was created.
  const cabFile = profileDir.clone();
  cabFile.append(kCABData.fileName);
  ok(cabFile.exists());
});

add_task(async function createAddressBook() {
  const dirPrefId = MailServices.ab.newAddressBook(
    "new book",
    "",
    Ci.nsIAbManager.JS_DIRECTORY_TYPE
  );
  book = MailServices.ab.getDirectoryFromId(dirPrefId);
  observer.checkEvents(["addrbook-directory-created", book]);

  // Check nsIAbDirectory properties.
  ok(!book.readOnly);
  ok(!book.isRemote);
  ok(!book.isSecure);
  equal(book.dirName, "new book");
  equal(book.dirType, Ci.nsIAbManager.JS_DIRECTORY_TYPE);
  equal(book.fileName, FILE_NAME);
  equal(book.UID.length, 36);
  equal(book.URI, `${SCHEME}://${FILE_NAME}`);
  equal(book.isMailList, false);
  equal(book.supportsMailingLists, true);
  equal(book.dirPrefId, "ldap_2.servers.newbook");

  // Check enumerations.
  equal(Array.from(book.childNodes).length, 0);
  equal(Array.from(book.childCards).length, 0);

  // Check prefs.
  equal(
    Services.prefs.getStringPref("ldap_2.servers.newbook.description"),
    "new book"
  );
  equal(
    Services.prefs.getIntPref("ldap_2.servers.newbook.dirType"),
    Ci.nsIAbManager.JS_DIRECTORY_TYPE
  );
  equal(
    Services.prefs.getStringPref("ldap_2.servers.newbook.filename"),
    FILE_NAME
  );
  equal(Services.prefs.getStringPref("ldap_2.servers.newbook.uid"), book.UID);
  equal(MailServices.ab.directories.length, baseAddressBookCount + 1);

  // Check the file was created.
  const dbFile = Services.dirsvc.get("ProfD", Ci.nsIFile);
  dbFile.append(FILE_NAME);
  ok(dbFile.exists());
});

add_task(async function editAddressBook() {
  book.dirName = "updated book";
  observer.checkEvents(["addrbook-directory-updated", book, "DirName"]);
  equal(book.dirName, "updated book");
  equal(
    Services.prefs.getStringPref("ldap_2.servers.newbook.description"),
    "updated book"
  );
});

add_task(async function createContact() {
  contact = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  contact.displayName = "a new contact";
  contact.firstName = "new";
  contact.lastName = "contact";
  contact.primaryEmail = "test@invalid";
  contact.setProperty("Foo", "This will be deleted later.");
  contact = book.addCard(contact);
  observer.checkEvents(["addrbook-contact-created", contact, book.UID]);

  const cards = book.childCards;
  equal(cards.length, 1);
  ok(cards[0].equals(contact));

  // Check nsIAbCard properties.
  equal(contact.directoryUID, book.UID);
  equal(contact.UID.length, 36);
  equal(contact.firstName, "new");
  equal(contact.lastName, "contact");
  equal(contact.displayName, "a new contact");
  equal(contact.primaryEmail, "test@invalid");
  equal(contact.getProperty("Foo", ""), "This will be deleted later.");
  equal(contact.isMailList, false);
  const modifiedDate = parseInt(
    contact.getProperty("LastModifiedDate", ""),
    10
  );
  Assert.lessOrEqual(modifiedDate, Date.now() / 1000);
  Assert.greater(modifiedDate, Date.now() / 1000 - 10);

  // Check nsIAbCard methods.
  equal(
    contact.generateName(Ci.nsIAbCard.GENERATE_DISPLAY_NAME),
    "a new contact"
  );
  equal(
    contact.generateName(Ci.nsIAbCard.GENERATE_LAST_FIRST_ORDER),
    "contact, new"
  );
  equal(
    contact.generateName(Ci.nsIAbCard.GENERATE_FIRST_LAST_ORDER),
    "new contact"
  );
});

add_task(async function editContact() {
  contact.firstName = "updated";
  contact.lastName = "contact";
  contact.displayName = "updated contact";
  contact.setProperty("Foo", null);
  contact.setProperty("Bar1", "a new property");
  contact.setProperty("Bar2", "");
  contact.setProperty("LastModifiedDate", 0);
  book.modifyCard(contact);
  const [, propertyEvent] = observer.checkEvents(
    ["addrbook-contact-updated", contact, book.UID],
    ["addrbook-contact-properties-updated", contact]
  );
  Assert.deepEqual(JSON.parse(propertyEvent[2]), {
    DisplayName: {
      oldValue: "a new contact",
      newValue: "updated contact",
    },
    Foo: {
      oldValue: "This will be deleted later.",
      newValue: null,
    },
    Bar1: {
      oldValue: null,
      newValue: "a new property",
    },
    FirstName: {
      oldValue: "new",
      newValue: "updated",
    },
    _vCard: {
      oldValue: formatVCard`
        BEGIN:VCARD
        VERSION:4.0
        FN:a new contact
        EMAIL;PREF=1:test@invalid
        N:contact;new;;;
        UID:${contact.UID}
        END:VCARD`,
      newValue: formatVCard`
        BEGIN:VCARD
        VERSION:4.0
        FN:updated contact
        EMAIL;PREF=1:test@invalid
        N:contact;updated;;;
        UID:${contact.UID}
        END:VCARD`,
    },
  });
  contact = book.childCards[0];
  equal(contact.firstName, "updated");
  equal(contact.lastName, "contact");
  equal(contact.displayName, "updated contact");
  equal(contact.getProperty("Foo", "empty"), "empty");
  equal(contact.getProperty("Bar1", ""), "a new property");
  equal(contact.getProperty("Bar2", "no value"), "no value");
  const modifiedDate = parseInt(
    contact.getProperty("LastModifiedDate", ""),
    10
  );
  Assert.lessOrEqual(modifiedDate, Date.now() / 1000);
  Assert.greater(modifiedDate, Date.now() / 1000 - 10);
});

add_task(async function createMailingList() {
  list = Cc["@mozilla.org/addressbook/directoryproperty;1"].createInstance(
    Ci.nsIAbDirectory
  );
  list.isMailList = true;
  list.dirName = "new list";
  list = book.addMailList(list);
  // Skip checking events temporarily, until listCard is defined.

  // Check enumerations.
  const childNodes = book.childNodes;
  equal(childNodes.length, 1);
  equal(childNodes[0].UID, list.UID); // TODO Object equality doesn't work because of XPCOM.
  const childCards = book.childCards;
  equal(childCards.length, 2);
  if (childCards[0].isMailList) {
    listCard = childCards[0];
    ok(childCards[1].equals(contact));
  } else {
    ok(childCards[0].equals(contact));
    listCard = childCards[1];
  }
  equal(listCard.UID, list.UID);

  observer.checkEvents(["addrbook-list-created", list, book.UID]);

  // Check nsIAbDirectory properties.
  equal(list.dirName, "new list");
  equal(list.UID.length, 36);
  equal(list.URI, `${SCHEME}://${FILE_NAME}/${list.UID}`);
  equal(list.isMailList, true);
  equal(list.supportsMailingLists, false);

  // Check list enumerations.
  equal(Array.from(list.childNodes).length, 0);
  equal(Array.from(list.childCards).length, 0);

  // Check nsIAbCard properties.
  equal(listCard.firstName, "");
  equal(listCard.lastName, "new list");
  equal(listCard.primaryEmail, "");
  equal(listCard.displayName, "new list");
});

add_task(async function editMailingList() {
  list.dirName = "updated list";
  list.editMailListToDatabase(null);
  observer.checkEvents(["addrbook-list-updated", list, book.UID]);
  equal("updated list", list.dirName);
});

add_task(async function addMailingListMember() {
  list.addCard(contact);
  observer.checkEvents(["addrbook-list-member-added", contact, list.UID]);

  // Check list enumerations.
  equal(Array.from(list.childNodes).length, 0);
  const childCards = list.childCards;
  equal(childCards.length, 1);
  ok(childCards[0].equals(contact));
});

add_task(async function removeMailingListMember() {
  list.deleteCards([contact]);
  observer.checkEvents(["addrbook-list-member-removed", contact, list.UID]);

  // Check list enumerations.
  equal(Array.from(list.childNodes).length, 0);
  equal(Array.from(list.childCards).length, 0);
});

add_task(async function deleteMailingList() {
  book.deleteDirectory(list);
  observer.checkEvents(["addrbook-list-deleted", list, book.UID]);
});

add_task(async function deleteContact() {
  book.deleteCards([contact]);
  observer.checkEvents(["addrbook-contact-deleted", contact, book.UID]);

  // Check enumerations.
  equal(Array.from(book.childNodes).length, 0);
  equal(Array.from(book.childCards).length, 0);
});

// Tests that the UID on a new contact can be set.
add_task(async function createContactWithUID() {
  let contactWithUID = Cc[
    "@mozilla.org/addressbook/cardproperty;1"
  ].createInstance(Ci.nsIAbCard);
  contactWithUID.UID = "I'm a UID!";
  contactWithUID = book.addCard(contactWithUID);
  equal("I'm a UID!", contactWithUID.UID, "New contact has the UID we set");

  Assert.throws(() => {
    // Set the UID after it already exists.
    contactWithUID.UID = "This should not be possible";
  }, /NS_ERROR_UNEXPECTED/);

  // Setting the UID to it's existing value should not fail.
  contactWithUID.UID = contactWithUID.UID; // eslint-disable-line no-self-assign

  book.deleteCards([contactWithUID]);
  observer.events.length = 0;
});

add_task(async function deleteAddressBook() {
  await promiseDirectoryRemoved(book.URI);

  observer.checkEvents(["addrbook-directory-deleted", book, null]);
  ok(!Services.prefs.prefHasUserValue("ldap_2.servers.newbook.dirType"));
  ok(!Services.prefs.prefHasUserValue("ldap_2.servers.newbook.description"));
  ok(!Services.prefs.prefHasUserValue("ldap_2.servers.newbook.filename"));
  ok(!Services.prefs.prefHasUserValue("ldap_2.servers.newbook.uid"));
  const dbFile = Services.dirsvc.get("ProfD", Ci.nsIFile);
  dbFile.append(FILE_NAME);
  ok(!dbFile.exists());
  equal(MailServices.ab.directories.length, baseAddressBookCount);
  Assert.throws(() => {
    MailServices.ab.getDirectory(`${SCHEME}://${FILE_NAME}`);
  }, /NS_ERROR_FAILURE/);
});

add_task(async function cleanUp() {
  observer.checkEvents();
  observer.cleanUp();
});

add_task(async function test_exactMailingListMemberUIDs() {
  const { SQLiteDirectory } = ChromeUtils.importESModule(
    "resource:///modules/SQLiteDirectory.sys.mjs"
  );
  const { AddrBookMailingList } = ChromeUtils.importESModule(
    "resource:///modules/AddrBookMailingList.sys.mjs"
  );
  const prefId = MailServices.ab.newAddressBook(
    "Exact member UIDs",
    "",
    Ci.nsIAbManager.JS_DIRECTORY_TYPE
  );
  const directory = MailServices.ab.getDirectoryFromId(prefId);
  const uri = directory.URI;
  registerCleanupFunction(async () => {
    if (MailServices.ab.directories.some(item => item.URI == uri)) {
      await promiseDirectoryRemoved(uri);
    }
  });
  const parent = SQLiteDirectory.forFile(directory.fileName);
  Assert.equal(parent.URI, uri);
  const cards = ["\uFEFFmember-id", "member-id", "member-\uFEFF\u00E9"].map(
    (uid, index) => {
      const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
        Ci.nsIAbCard
      );
      card.UID = uid;
      card.primaryEmail = `member${index}@example.invalid`;
      const added = directory.addCard(card);
      Assert.equal(added.UID, uid);
      Assert.equal(added.primaryEmail, card.primaryEmail);
      return added;
    }
  );
  const rawLists = ["\uFEFFlist-id", "list-id"].map(
    (uid, index) =>
      new AddrBookMailingList(uid, parent, `Exact list ${index}`, "", "")
  );
  for (const mailingList of rawLists) {
    parent.saveList(mailingList);
  }
  const [exact, plain] = rawLists.map(mailingList => mailingList.asDirectory);
  const events = [];
  const observe = (subject, topic, data) => {
    events.push([topic, subject.QueryInterface(Ci.nsIAbCard).UID, data]);
  };
  const topics = ["addrbook-list-member-added", "addrbook-list-member-removed"];
  for (const topic of topics) {
    Services.obs.addObserver(observe, topic);
  }
  registerCleanupFunction(() => {
    for (const topic of topics) {
      Services.obs.removeObserver(observe, topic);
    }
  });
  for (const card of cards) {
    exact.addCard(card);
  }
  plain.addCard(cards[1]);
  Assert.deepEqual(
    exact.childCards.map(card => [card.UID, card.primaryEmail]),
    cards.map(card => [card.UID, card.primaryEmail]),
    "Exact member identities and insertion order survive enumeration"
  );
  Assert.deepEqual(
    plain.childCards.map(card => card.UID),
    [cards[1].UID]
  );
  Assert.deepEqual(events, [
    ...cards.map(card => ["addrbook-list-member-added", card.UID, exact.UID]),
    ["addrbook-list-member-added", cards[1].UID, plain.UID],
  ]);
  events.length = 0;
  exact.deleteCards([cards[0]]);
  Assert.deepEqual(
    exact.childCards.map(card => card.UID),
    [cards[1].UID, cards[2].UID]
  );
  Assert.deepEqual(
    plain.childCards.map(card => card.UID),
    [cards[1].UID]
  );
  Assert.deepEqual(events, [
    ["addrbook-list-member-removed", cards[0].UID, exact.UID],
  ]);
  events.length = 0;
  exact.deleteCards([cards[0]]);
  Assert.deepEqual(events, [], "A missing membership emits no removal event");
  const connection = parent._dbConnection;
  connection.executeSimpleSQL(
    "ALTER TABLE list_cards RENAME TO unavailable_members"
  );
  try {
    Assert.throws(() => exact.childCards, /NS_ERROR_FAILURE/);
    Assert.throws(() => exact.addCard(cards[0]), /NS_ERROR_FAILURE/);
    Assert.throws(() => exact.deleteCards([cards[1]]), /NS_ERROR_FAILURE/);
    Assert.deepEqual(events, [], "Failed storage does not announce membership");
  } finally {
    connection.executeSimpleSQL(
      "ALTER TABLE unavailable_members RENAME TO list_cards"
    );
  }
  Assert.deepEqual(
    exact.childCards.map(card => card.UID),
    [cards[1].UID, cards[2].UID]
  );
  Assert.deepEqual(
    plain.childCards.map(card => card.UID),
    [cards[1].UID]
  );
  Assert.equal(directory.childNodes.length, 2);
  Assert.equal(directory.childCards.filter(card => !card.isMailList).length, 3);
});

// The migration reader/validator is packaged in Nightly; original tasks above
// remain enabled in every configuration.
const migrationPublicationOnly = () => ({
  skip_if: () => !AppConstants.NIGHTLY_BUILD,
});
let migrationPublicationSerial = 0;
let migrationPublicationDirectoriesRegistered = false;
let migrationPublicationProfile;
let migrationPublicationStartupLock;

/**
 * Creates a genuine closed stage under a retained native startup-profile lock.
 *
 * @returns {Promise<object>} Owned fixture, adoption call, events and cleanup.
 */
async function migrationPublicationInput() {
  const { FileUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/FileUtils.sys.mjs"
  );
  const { SQLiteDirectory } = ChromeUtils.importESModule(
    "resource:///modules/SQLiteDirectory.sys.mjs"
  );
  const { withMigrationAddressBookPublication } = ChromeUtils.importESModule(
    "resource:///modules/AddrBookManager.sys.mjs"
  );
  // Directory-service registrations outlive each fixture's profile and lock.
  if (!migrationPublicationDirectoriesRegistered) {
    const provider = Cc["@mozilla.org/xre/directory-provider;1"]
      .getService(Ci.nsIDirectoryServiceProvider)
      .QueryInterface(Ci.nsIXREDirProvider);
    for (const key of ["DefProfRt", "DefProfLRt", "UAppData"]) {
      Services.dirsvc.set(key, provider.getFile(key, {}).clone());
    }
    migrationPublicationDirectoriesRegistered = true;
  }
  const profiles = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  if (!migrationPublicationProfile) {
    const created = profiles.createProfile(
      do_get_profile(),
      "manager-publication-startup",
      "tests"
    );
    registerCleanupFunction(() => {
      migrationPublicationStartupLock?.unlock();
      created.remove(false);
    });
    const root = {};
    const local = {};
    const selected = {};
    profiles.selectStartupProfile(
      ["xpcshell", "-P", created.name],
      false,
      AppConstants.MOZ_UPDATE_CHANNEL,
      "",
      root,
      local,
      selected
    );
    Assert.equal(selected.value, created, "Actual named startup selection");
    Assert.equal(profiles.currentProfile, created);
    Assert.ok(root.value.equals(do_get_profile()));
    migrationPublicationStartupLock = created.lock({});
    migrationPublicationProfile = created;
  }
  const profile = migrationPublicationProfile;
  const serial = ++migrationPublicationSerial;
  const stageFile = do_get_profile().clone();
  stageFile.append("manager-stage-" + serial + ".sqlite");
  const sourceBytes = await IOUtils.read(do_get_file("import.mab").path);
  const db = SQLiteDirectory.createMigrationStage(stageFile);
  let committed;
  try {
    committed = SQLiteDirectory.importMorkSnapshot(
      db,
      sourceBytes,
      "manager-storage-" + serial
    );
  } finally {
    db.close();
  }
  const canonicalStage = stageFile.clone();
  canonicalStage.normalize();
  const receipt = {
    token: committed.sourceId,
    sourceId: "manager-source-" + serial,
    storageSourceId: committed.sourceId,
    sourceSha256: committed.sourceSha256,
    sourceSize: committed.sourceSize,
    // Like the coordinator's journal, record the canonical stage path; macOS
    // temporary profiles sit below the system /tmp link.
    stagingPath: canonicalStage.path,
    cards: committed.cards,
    lists: committed.lists,
    // As the coordinator receipt does, retain the Windows stage identity.
    ...(committed.stagePhysicalIdentity
      ? { stagePhysicalIdentity: committed.stagePhysicalIdentity }
      : {}),
  };
  const options = {
    stageFile,
    sourceBytes,
    receipt,
    bookUID: "manager-book-" + serial,
    dirName: "Imported whole book " + serial,
  };
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(Ci.nsICryptoHash.SHA256);
  const identity = new TextEncoder().encode(
    JSON.stringify([receipt.sourceId, receipt.storageSourceId, options.bookUID])
  );
  hash.update(identity, identity.length);
  const digest = Array.from(hash.finish(false), byte =>
    byte.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
  const target = do_get_profile().clone();
  target.append("panorama-import-" + digest + ".sqlite");
  const pref = "ldap_2.servers.panorama_import_" + digest;
  const events = [];
  const observe = (subject, topic) => events.push([topic, subject]);
  const topics = [
    "addrbook-directory-created",
    "addrbook-contact-created",
    "addrbook-contacts-created",
    "addrbook-list-created",
    "addrbook-list-member-added",
  ];
  for (const topic of topics) {
    Services.obs.addObserver(observe, topic);
  }
  let cleaned = false;
  const prefsFile = do_get_profile().clone();
  prefsFile.append("prefs.js");
  const input = {
    options,
    profile,
    prefsFile,
    managerGlobal: Cu.getGlobalForObject(withMigrationAddressBookPublication),
    managerServices: Cu.getGlobalForObject(withMigrationAddressBookPublication)
      .Services,
    target,
    pref,
    events,
    SQLiteDirectory,
    FileUtils,
    run: callback => withMigrationAddressBookPublication(profile, callback),
    withProfile: (selected, callback) =>
      withMigrationAddressBookPublication(selected, callback),
    adopt: () =>
      withMigrationAddressBookPublication(profile, publication =>
        publication.adopt(options)
      ),
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      for (const topic of topics) {
        Services.obs.removeObserver(observe, topic);
      }
      const uri = "jsaddrbook://" + target.leafName;
      if (MailServices.ab.directories.some(dir => dir.URI == uri)) {
        await promiseDirectoryRemoved(uri);
      }
      Services.prefs.deleteBranch(pref + ".");
      if (target.exists()) {
        target.remove(false);
      }
      if (stageFile.exists()) {
        stageFile.remove(false);
      }
    },
  };
  registerCleanupFunction(() => input.cleanup());
  return input;
}

/**
 * Verifies a separate native process still cannot acquire the startup lock.
 *
 * @returns {Promise<void>} Child refused the actual native lock and exited.
 */
async function assertMigrationStartupProfileHeld() {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const directories = Object.fromEntries(
    ["DefProfRt", "DefProfLRt", "UAppData"].map(key => [
      key,
      Services.dirsvc.get(key, Ci.nsIFile).path,
    ])
  );
  const code = [
    "const provider = Cc['@mozilla.org/xre/directory-provider;1'].getService(Ci.nsIXREDirProvider);",
    "const directories = " + JSON.stringify(directories) + ";",
    "for (const [key, path] of Object.entries(directories)) { const dir = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile); dir.initWithPath(path); Services.dirsvc.set(key, dir); }",
    "const root = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);",
    "root.initWithPath(" + JSON.stringify(do_get_profile().path) + ");",
    "Services.dirsvc.set('ProfD', root.clone()); Services.dirsvc.set('ProfLD', root.clone());",
    "const profiles = Cc['@mozilla.org/toolkit/profile-service;1'].getService(Ci.nsIToolkitProfileService);",
    "const profile = profiles.createProfile(root, 'publication-lock-probe', 'tests');",
    "let lock;",
    "try { lock = profile.lock({}); } catch (error) { print('PUBLICATION-LOCK-REFUSED ' + error.result); quit(error.result == Cr.NS_ERROR_FILE_ACCESS_DENIED ? 0 : 3); }",
    "print('PUBLICATION-LOCK-ACQUIRED'); lock.unlock(); quit(2);",
  ].join("\n");
  let child;
  let output = "";
  let terminal;
  let readError;
  let done = false;
  let reading;
  try {
    child = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: [
        ...(mozinfo.msix ? ["--xpcshell"] : []),
        "-g",
        Services.dirsvc.get("GreD", Ci.nsIFile).path,
        "-a",
        Services.dirsvc.get("XCurProcD", Ci.nsIFile).path,
        "-e",
        code,
      ],
      stderr: "stdout",
    });
    reading = (async () => {
      try {
        for (let chunk; (chunk = await child.stdout.readString()); ) {
          output += chunk;
        }
        terminal = await child.wait();
      } catch (error) {
        readError = error;
      } finally {
        done = true;
      }
    })();
    await TestUtils.waitForCondition(
      () => done,
      "Actual startup-lock exclusion child exits",
      100,
      300
    );
    if (readError) {
      throw readError;
    }
    Assert.equal(terminal.exitCode, 0, output);
    Assert.ok(
      output.includes(
        "PUBLICATION-LOCK-REFUSED " + Cr.NS_ERROR_FILE_ACCESS_DENIED
      ),
      output
    );
    Assert.ok(!output.includes("PUBLICATION-LOCK-ACQUIRED"), output);
    Assert.ok(!output.includes("###!!! ASSERTION"), output);
  } finally {
    if (child && !done) {
      child.kill();
    }
    await reading;
  }
}

/**
 * Fails a real native write after a private copy exists, then retries unchanged.
 *
 * The scoped JS class-table proxy delegates to the real builtin stream. It closes
 * that stream after one real byte and propagates its actual closed-stream write
 * error; it does not return a fabricated write result or error.
 *
 * @returns {Promise<void>} Strict native error, private orphan and retry checked.
 */
async function assertMigrationPrivateCopyFailure() {
  const input = await migrationPublicationInput();
  const global = input.managerGlobal;
  const classes = global.Cc;
  const descriptor = Object.getOwnPropertyDescriptor(global, "Cc");
  Assert.ok(descriptor.writable && descriptor.configurable);
  const contract = "@mozilla.org/network/file-output-stream;1";
  const originalStage = await IOUtils.read(input.options.stageFile.path);
  let partial;
  let nativeFailure;
  let reached = false;
  // Only the test's JS call boundary is replaced. The factory still creates a
  // real builtin nsIFileOutputStream; no XPCOM factory or QI is emulated.
  global.Cc = new Proxy(
    {},
    {
      get(target, name) {
        if (name != contract) {
          return classes[name];
        }
        return {
          createInstance(iid) {
            const stream = classes[contract].createInstance(iid);
            Assert.equal(stream.QueryInterface(Ci.nsIFileOutputStream), stream);
            let destination;
            return new Proxy(
              {},
              {
                get(unused, method) {
                  if (method == "init") {
                    return (file, ...args) => {
                      stream.init(file, ...args);
                      destination = file.clone();
                    };
                  }
                  if (method == "write") {
                    return (bytes, count) => {
                      if (
                        !reached &&
                        destination.leafName.startsWith(
                          input.target.leafName + ".copy"
                        )
                      ) {
                        partial = destination.clone();
                        reached = true;
                        stream.write(bytes.substring(0, 1), 1);
                        stream.close();
                        try {
                          return stream.write(bytes, count);
                        } catch (error) {
                          nativeFailure = error;
                          throw error;
                        }
                      }
                      return stream.write(bytes, count);
                    };
                  }
                  const value = stream[method];
                  return typeof value == "function"
                    ? value.bind(stream)
                    : value;
                },
              }
            );
          },
        };
      },
    }
  );
  try {
    let failure;
    try {
      await input.adopt();
    } catch (error) {
      failure = error;
    } finally {
      Object.defineProperty(global, "Cc", descriptor);
    }
    Assert.ok(
      reached,
      "Real native write reached after exclusive copy creation"
    );
    Assert.ok(nativeFailure, "Actual native closed-stream write failed");
    Assert.ok(failure, "Original copy failure reaches the caller");
    Assert.equal(
      failure,
      nativeFailure,
      "First actual native write error object"
    );
    Assert.equal(failure.result, nativeFailure.result);
    Assert.equal(failure.result, Cr.NS_BASE_STREAM_CLOSED);
    Assert.ok(partial.exists());
    Assert.equal(partial.fileSize, 1);
    Assert.deepEqual(
      await IOUtils.read(partial.path),
      originalStage.slice(0, 1)
    );
    Assert.ok(
      !input.target.exists(),
      "No incomplete copy occupies the stable target"
    );
    Assert.equal(
      JSON.parse(
        Services.prefs.getStringPref(input.pref + ".panoramaMigration")
      ).state,
      "prepared"
    );
    Assert.deepEqual(input.events, []);
    await assertMigrationStartupProfileHeld();

    // A prepared record does not authorize deleting unrelated occupied data.
    const foreignBytes = new TextEncoder().encode("unrelated occupied target");
    await IOUtils.write(input.target.path, foreignBytes);
    try {
      await Assert.rejects(input.adopt(), /./);
      Assert.deepEqual(await IOUtils.read(input.target.path), foreignBytes);
      Assert.deepEqual(input.events, []);
    } finally {
      input.target.remove(false);
    }

    // The failed private copy also models an interruption before the final move.
    // It remains byte-exact while a fresh exclusive sibling completes the retry.
    assertMigrationPublication(input, await input.adopt());
    Assert.deepEqual(
      await IOUtils.read(partial.path),
      originalStage.slice(0, 1)
    );
    Assert.deepEqual(
      input.events.map(([topic]) => topic),
      ["addrbook-directory-created"]
    );
    input.events.length = 0;
    Assert.equal((await input.adopt()).reused, true);
    Assert.deepEqual(input.events, []);
    Assert.deepEqual(
      await IOUtils.read(input.options.stageFile.path),
      originalStage
    );
    await assertMigrationStartupProfileHeld();
  } finally {
    Object.defineProperty(global, "Cc", descriptor);
    if (partial?.exists()) {
      partial.remove(false);
    }
    await input.cleanup();
  }
}

/**
 * Checks complete normal readers and exact raw values after publication.
 *
 * @param {object} input - Genuine fixture.
 * @param {object} result - Actual Manager publication result.
 */
function assertMigrationPublication(input, result) {
  const { receipt } = input.options;
  Assert.equal(result.directory, MailServices.ab.getDirectory(result.uri));
  Assert.equal(result.directory.UID, input.options.bookUID);
  Assert.equal(result.directory.dirPrefId, input.pref);
  Assert.equal(result.fileName, input.target.leafName);
  Assert.equal(result.directory.dirName, input.options.dirName);
  Assert.deepEqual(result.cards, receipt.cards);
  Assert.deepEqual(result.lists, receipt.lists);
  const card = result.directory.childCards.find(
    entry => entry.UID == receipt.cards[0][1]
  );
  Assert.ok(card, "The original imported card is publicly enumerable");
  Assert.equal(card.displayName, "contact number one");
  Assert.equal(card.primaryEmail, "contact1@invalid");
  const lists = result.directory.childNodes;
  Assert.equal(lists.length, 1);
  Assert.equal(lists[0].UID, receipt.lists[0][1]);
  Assert.equal(lists[0].dirName, "list");
  Assert.equal(lists[0].listNickName, "nick name");
  Assert.equal(lists[0].description, "a list of cards");
  Assert.deepEqual(
    lists[0].childCards.map(member => member.UID),
    [card.UID]
  );
  const nativeBook = input.SQLiteDirectory.forFile(result.fileName);
  const raw = nativeBook.loadMigrationProperties(card.UID);
  Assert.ok(raw.has("Notes"));
  Assert.equal(raw.get("Notes"), "");
  Assert.ok(raw.has("Custom1"));
  Assert.equal(raw.get("Custom1"), "");
  Assert.ok(!raw.has("UID"), "Missing original UID remains absent, not empty");
}

/** @returns {Promise<void>} Normal Manager reconstruction after real cleanup. */
async function reloadMigrationPublicationManager() {
  const reloaded = TestUtils.topicObserved("addrbook-reloaded");
  Services.obs.notifyObservers(null, "addrbook-reload");
  await reloaded;
}

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBook() {
    const input = await migrationPublicationInput();
    try {
      const stageBytes = await IOUtils.read(input.options.stageFile.path);
      const result = await input.adopt();
      Assert.equal(result.reused, false);
      assertMigrationPublication(input, result);
      Assert.deepEqual(
        input.events.map(([topic]) => topic),
        ["addrbook-directory-created"],
        "Whole-book publication does not replay card/list creation"
      );
      Assert.equal(input.events[0][1], result.directory);
      Assert.deepEqual(
        await IOUtils.read(input.options.stageFile.path),
        stageBytes,
        "The closed original stage remains unchanged"
      );
      Assert.deepEqual(
        await IOUtils.read(do_get_file("import.mab").path),
        input.options.sourceBytes
      );
    } finally {
      await input.cleanup();
    }
  }
);

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBookWithReloadAndRetry() {
    const input = await migrationPublicationInput();
    try {
      const first = await input.adopt();
      const saved = input.prefsFile.clone();
      saved.leafName += ".manager-fixture";
      saved.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      try {
        await Services.prefs.backupPrefFile(saved);
        saved.moveTo(null, input.prefsFile.leafName);
      } finally {
        if (!saved.equals(input.prefsFile) && saved.exists()) {
          saved.remove(false);
        }
      }
      input.events.length = 0;
      await reloadMigrationPublicationManager();
      const result = await input.adopt();
      Assert.equal(result.reused, true);
      Assert.equal(result.uri, first.uri);
      Assert.equal(result.dirPrefId, first.dirPrefId);
      assertMigrationPublication(input, result);
      Assert.deepEqual(input.events, []);
      Assert.equal(
        MailServices.ab.directories.filter(dir => dir.UID == result.bookUID)
          .length,
        1
      );
    } finally {
      await input.cleanup();
    }
  }
);

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBookWithChangedReceipt() {
    const input = await migrationPublicationInput();
    try {
      const original = structuredClone(input.options.receipt);
      input.options.receipt.cards[0][1] += "-wrong";
      await Assert.rejects(input.adopt(), /scoped UID maps changed/);
      await Assert.rejects(
        input.run(publication => {
          // The scope must observe a failed adoption even without this await.
          publication.adopt(input.options);
          return "must not report successful publication";
        }),
        /scoped UID maps changed/
      );
      input.options.receipt = original;
      const source = Uint8Array.from(input.options.sourceBytes);
      input.options.sourceBytes[0] ^= 1;
      await Assert.rejects(input.adopt(), /./);
      input.options.sourceBytes = source;
      Assert.ok(!input.target.exists());
      Assert.deepEqual(Services.prefs.getChildList(input.pref + "."), []);
      Assert.deepEqual(input.events, []);
      assertMigrationPublication(input, await input.adopt());
    } finally {
      await input.cleanup();
    }
  }
);

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBookWithOccupiedDestination() {
    const input = await migrationPublicationInput();
    try {
      await IOUtils.writeUTF8(input.target.path, "unrelated occupied bytes");
      await Assert.rejects(input.adopt(), /already occupied/);
      Assert.equal(
        await IOUtils.readUTF8(input.target.path),
        "unrelated occupied bytes"
      );
      Assert.deepEqual(Services.prefs.getChildList(input.pref + "."), []);
      Assert.deepEqual(input.events, []);
      input.target.remove(false);
      Services.prefs.setStringPref(input.pref + ".description", "unrelated");
      await Assert.rejects(input.adopt(), /already occupied/);
      Assert.equal(
        Services.prefs.getStringPref(input.pref + ".description"),
        "unrelated"
      );
      Services.prefs.deleteBranch(input.pref + ".");
      const foreignPref = input.pref + "_foreign";
      Services.prefs.setStringPref(
        foreignPref + ".filename",
        input.target.leafName
      );
      try {
        await Assert.rejects(input.adopt(), /reserved by another directory/);
        Assert.ok(!input.target.exists());
        Assert.equal(
          Services.prefs.getStringPref(foreignPref + ".filename"),
          input.target.leafName
        );
        Assert.deepEqual(input.events, []);
      } finally {
        Services.prefs.deleteBranch(foreignPref + ".");
      }
      const result = await input.adopt();
      const nativeBook = input.SQLiteDirectory.forFile(result.fileName);
      const card = result.directory.childCards.find(
        entry => entry.UID == result.cards[0][1]
      );
      card.displayName = "actual changed published card";
      result.directory.modifyCard(card);
      input.events.length = 0;
      await Assert.rejects(input.adopt(), /./);
      Assert.equal(
        nativeBook.getCard(card.UID).displayName,
        "actual changed published card"
      );
      Assert.deepEqual(input.events, []);
    } finally {
      await input.cleanup();
    }
  }
);

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBookWithWrongOrReleasedProfileLock() {
    const input = await migrationPublicationInput();
    const profiles = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
      Ci.nsIToolkitProfileService
    );
    const otherRoot = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "other-book-profile-"
    );
    const other = profiles.createProfile(
      new input.FileUtils.File(otherRoot),
      "other-manager-book-" + migrationPublicationSerial,
      "tests"
    );
    const stageBytes = await IOUtils.read(input.options.stageFile.path);
    try {
      await Assert.rejects(
        input.withProfile(other, publication =>
          publication.adopt(input.options)
        ),
        /another profile/
      );
      const released = await input.run(publication => publication);
      Assert.ok(Object.isFrozen(released));
      Assert.deepEqual(Object.keys(released).sort(), ["adopt", "checkProfile"]);
      Assert.throws(
        () => released.checkProfile(),
        /Book publication operation is closed/
      );
      await Assert.rejects(
        released.adopt(input.options),
        /Book publication operation is closed/
      );
      Assert.ok(!input.target.exists());
      Assert.deepEqual(Services.prefs.getChildList(input.pref + "."), []);
      Assert.deepEqual(input.events, []);
      Assert.deepEqual(
        await IOUtils.read(input.options.stageFile.path),
        stageBytes,
        "Closed capability does not mutate the genuine original stage"
      );
      await assertMigrationStartupProfileHeld();
      Assert.ok(
        migrationPublicationStartupLock.directory.equals(do_get_profile())
      );
      assertMigrationPublication(input, await input.adopt());
      await assertMigrationStartupProfileHeld();
    } finally {
      other.remove(false);
      await IOUtils.remove(otherRoot, { recursive: true });
      await input.cleanup();
    }
  }
);

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBookWithOpenOrIncompleteStage() {
    const input = await migrationPublicationInput();
    const stagePref = input.pref + "_stage";
    let stageDirectory;
    try {
      Services.prefs.setStringPref(
        stagePref + ".filename",
        input.options.stageFile.leafName
      );
      stageDirectory = new input.SQLiteDirectory();
      stageDirectory.init("jsaddrbook://" + input.options.stageFile.leafName);
      await Assert.rejects(input.adopt(), /./);
      await stageDirectory.cleanUp();
      stageDirectory = null;
      Services.prefs.deleteBranch(stagePref + ".");
      const db = Services.storage.openUnsharedDatabase(input.options.stageFile);
      try {
        db.executeSimpleSQL("DELETE FROM list_cards");
      } finally {
        db.close();
      }
      await Assert.rejects(input.adopt(), /./);
      Assert.ok(!input.target.exists());
      Assert.deepEqual(Services.prefs.getChildList(input.pref + "."), []);
      Assert.deepEqual(input.events, []);
    } finally {
      await stageDirectory?.cleanUp();
      Services.prefs.deleteBranch(stagePref + ".");
      await input.cleanup();
    }
  }
);

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBookWithRealCopyFailure() {
    const input = await migrationPublicationInput();
    const validate = input.SQLiteDirectory.validateMigrationBook;
    const retained = input.options.stageFile.clone();
    retained.leafName += ".retained";
    let validated = false;
    try {
      input.SQLiteDirectory.validateMigrationBook = function (...args) {
        const result = validate.apply(this, args);
        if (args[0].equals(input.options.stageFile)) {
          if (validated) {
            args[0].clone().moveTo(null, retained.leafName);
          }
          validated = true;
        }
        return result;
      };
      let failure;
      try {
        await input.adopt();
      } catch (error) {
        failure = error;
      } finally {
        input.SQLiteDirectory.validateMigrationBook = validate;
      }
      Assert.ok(validated, "Actual original stage validator completed first");
      Assert.ok(failure, "Real input stream cannot open the moved stage");
      Assert.equal(failure.result, Cr.NS_ERROR_FILE_NOT_FOUND);
      await assertMigrationStartupProfileHeld();
      Assert.deepEqual(input.events, []);
      Assert.equal(
        JSON.parse(
          Services.prefs.getStringPref(input.pref + ".panoramaMigration")
        ).state,
        "prepared"
      );
      Assert.ok(
        retained.exists(),
        "Failed source bytes remain in owned custody"
      );
      retained.moveTo(null, input.options.stageFile.leafName);
      assertMigrationPublication(input, await input.adopt());
      Assert.deepEqual(
        input.events.map(([topic]) => topic),
        ["addrbook-directory-created"]
      );
    } finally {
      input.SQLiteDirectory.validateMigrationBook = validate;
      if (retained.exists() && !retained.equals(input.options.stageFile)) {
        retained.moveTo(null, input.options.stageFile.leafName);
      }
      await input.cleanup();
    }
    await assertMigrationPrivateCopyFailure();
  }
);

/**
 * Obstructs the real current preference destination at a durable boundary.
 *
 * No preference-service method returns a stub error: a completed native backup
 * must fail the real same-directory commit without publishing the book.
 *
 * @param {boolean} atPublished - Obstruct after the real target validates,
 *   otherwise obstruct before the prepared preference backup/commit.
 * @returns {Promise<void>} Obstruction restored and identical retry completed.
 */
async function assertMigrationPreferenceWriteFailure(atPublished) {
  const input = await migrationPublicationInput();
  const validate = input.SQLiteDirectory.validateMigrationBook;
  const retained = input.prefsFile.clone();
  retained.leafName += ".manager-retained-" + migrationPublicationSerial;
  const obstruction = input.prefsFile.clone();
  obstruction.append("manager-pref-obstruction");
  let obstructed = false;
  let reached = false;
  const restore = () => {
    if (retained.exists()) {
      if (obstructed && input.prefsFile.exists()) {
        // Remove only this fixture's empty obstruction, never original data.
        Assert.ok(input.prefsFile.isDirectory());
        if (obstruction.exists()) {
          obstruction.remove(false);
        }
        input.prefsFile.remove(false);
      }
      retained.copyTo(null, input.prefsFile.leafName);
      obstructed = false;
    }
  };
  const obstruct = () => {
    Assert.ok(!retained.exists(), "Fresh owned preference retention path");
    input.prefsFile.clone().moveTo(null, retained.leafName);
    input.prefsFile.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
    obstructed = true;
    obstruction.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
    reached = true;
  };
  try {
    // Establish a result-bearing baseline before obstructing the current file.
    const baseline = input.prefsFile.clone();
    baseline.leafName += ".manager-baseline";
    baseline.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
    await Services.prefs.backupPrefFile(baseline);
    baseline.moveTo(null, input.prefsFile.leafName);
    Assert.ok(input.prefsFile.isFile());
    if (atPublished) {
      input.SQLiteDirectory.validateMigrationBook = function (...args) {
        const result = validate.apply(this, args);
        if (args[0].equals(input.target) && !reached) {
          // This is after the real exclusive copy, readback and prepared save.
          obstruct();
        }
        return result;
      };
    } else {
      obstruct();
    }
    let failure;
    try {
      await input.adopt();
    } catch (error) {
      failure = error;
    } finally {
      input.SQLiteDirectory.validateMigrationBook = validate;
      // Restore synchronously before assertions or any event-loop yield.
      restore();
    }
    Assert.ok(reached, "The real preference destination was obstructed");
    Assert.ok(
      failure,
      "The native preference commit must report its actual failure"
    );
    Assert.equal(typeof failure.result, "number", "Original native nsresult");
    Assert.ok(!Components.isSuccessCode(failure.result));
    Assert.deepEqual(
      input.events,
      [],
      "A failed preference save never publishes"
    );
    Assert.equal(
      JSON.parse(
        Services.prefs.getStringPref(input.pref + ".panoramaMigration")
      ).state,
      "prepared",
      "First error leaves the exact retry state, not successful publication"
    );
    Assert.equal(input.target.exists(), atPublished);
    const persisted = await IOUtils.readUTF8(retained.path);
    const prefix =
      "user_pref(" + JSON.stringify(input.pref + ".panoramaMigration") + ", ";
    const line = persisted
      .split(/\r?\n/)
      .find(value => value.startsWith(prefix));
    if (atPublished) {
      Assert.ok(line, "Prepared state was durable before the second boundary");
      Assert.equal(
        JSON.parse(JSON.parse(line.slice(prefix.length, -2))).state,
        "prepared"
      );
      Assert.deepEqual(
        input.SQLiteDirectory.validateMigrationBook(
          input.target,
          input.options.sourceBytes,
          input.options.receipt.storageSourceId,
          { requireClosed: true }
        ).cards,
        input.options.receipt.cards,
        "The completed unpublished copy remains available for exact retry"
      );
    } else {
      Assert.ok(!line, "Failure preceded the first durable ownership write");
    }
    assertMigrationPublication(input, await input.adopt());
    Assert.deepEqual(
      input.events.map(([topic]) => topic),
      ["addrbook-directory-created"],
      "Same identity succeeds once after the real obstruction is removed"
    );
    input.events.length = 0;
    Assert.equal((await input.adopt()).reused, true);
    Assert.deepEqual(input.events, []);
  } finally {
    input.SQLiteDirectory.validateMigrationBook = validate;
    if (obstructed || !input.prefsFile.exists()) {
      restore();
    }
    if (retained.exists()) {
      retained.remove(false);
    }
    await input.cleanup();
  }
}

/**
 * Exercises the actual backup rejection or a genuine newer preference value.
 *
 * @param {boolean} atPublished - Exercise the second durable boundary.
 * @param {boolean} obstructBackup - Obstruct the native backup destination;
 *   otherwise change a real unrelated preference after the snapshot starts.
 * @returns {Promise<void>} Original failure/refusal and exact retry checked.
 */
async function assertMigrationPreferenceSnapshotFailure(
  atPublished,
  obstructBackup
) {
  const input = await migrationPublicationInput();
  const prefs = input.managerServices.prefs;
  const backup = prefs.backupPrefFile;
  const conflictPref =
    "test.manager-publication.snapshot-" + migrationPublicationSerial;
  let temporary;
  let obstruction;
  let nativeFailure;
  let reached = false;
  let concurrent;
  let activePublication;
  const baseline = input.prefsFile.clone();
  baseline.leafName += ".manager-snapshot-baseline";
  baseline.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  try {
    Services.prefs.setStringPref(conflictPref, "before");
    await backup.call(Services.prefs, baseline);
    baseline.moveTo(null, input.prefsFile.leafName);
    const snapshot = function (file, ...args) {
      const state = JSON.parse(
        Services.prefs.getStringPref(input.pref + ".panoramaMigration")
      ).state;
      if (reached || state != (atPublished ? "published" : "prepared")) {
        return backup.call(this, file, ...args);
      }
      reached = true;
      temporary = file.clone();
      if (obstructBackup) {
        // Fail the real safe writer, not a replacement returned-error method.
        file.remove(false);
        file.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
        obstruction = file.clone();
        obstruction.append("manager-backup-obstruction");
        obstruction.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      }
      let pending;
      try {
        pending = backup.call(this, file, ...args);
      } catch (error) {
        nativeFailure = error;
        throw error;
      }
      if (!obstructBackup) {
        Services.prefs.setStringPref(conflictPref, "after");
        concurrent = activePublication.adopt(input.options).then(
          () => ({ unexpectedlyPublished: true }),
          error => ({ error })
        );
      }
      return pending.then(
        async value => {
          if (!obstructBackup) {
            // Exercise reload while the published marker is still only pending.
            await reloadMigrationPublicationManager();
            Assert.ok(
              !MailServices.ab.directories.some(
                directory => directory.UID == input.options.bookUID
              ),
              "A pending preference snapshot never enumerates a live book"
            );
          }
          return value;
        },
        error => {
          nativeFailure = error;
          throw error;
        }
      );
    };
    // Native method properties are readonly. Replace only this module's
    // configurable service value, forwarding every operation to the actual
    // native service. The interceptor changes real input, never its result.
    input.managerServices.prefs = new Proxy(
      {},
      {
        get(target, name) {
          const value = name == "backupPrefFile" ? snapshot : prefs[name];
          return typeof value == "function" ? value.bind(prefs) : value;
        },
      }
    );
    let failure;
    try {
      await input.run(publication => {
        activePublication = publication;
        return publication.adopt(input.options);
      });
    } catch (error) {
      failure = error;
    } finally {
      input.managerServices.prefs = prefs;
      if (obstruction?.exists()) {
        obstruction.remove(false);
      }
      if (temporary?.exists()) {
        temporary.remove(false);
      }
    }
    Assert.ok(
      reached,
      "The selected actual native backup boundary was reached"
    );
    Assert.ok(
      failure,
      "Snapshot failure/refusal propagates before publication"
    );
    if (obstructBackup) {
      Assert.equal(failure, nativeFailure, "Original native rejection object");
      Assert.equal(typeof failure.result, "number");
      Assert.ok(!Components.isSuccessCode(failure.result));
    } else {
      Assert.equal(failure.result, Cr.NS_ERROR_IN_PROGRESS);
      Assert.equal(
        Services.prefs.getStringPref(conflictPref),
        "after",
        "A newer real preference value is never rolled back"
      );
      const refused = await concurrent;
      Assert.ok(!refused.unexpectedlyPublished);
      Assert.equal(refused.error.result, Cr.NS_ERROR_IN_PROGRESS);
    }
    Assert.deepEqual(input.events, [], "Neither failure path publishes");
    Assert.equal(
      JSON.parse(
        Services.prefs.getStringPref(input.pref + ".panoramaMigration")
      ).state,
      "prepared"
    );
    Assert.equal(input.target.exists(), atPublished);
    const persisted = await IOUtils.readUTF8(input.prefsFile.path);
    const prefix =
      "user_pref(" + JSON.stringify(input.pref + ".panoramaMigration") + ", ";
    const line = persisted
      .split(/\r?\n/)
      .find(value => value.startsWith(prefix));
    if (atPublished) {
      Assert.ok(
        line,
        "First durable boundary survives second-boundary failure"
      );
      Assert.equal(
        JSON.parse(JSON.parse(line.slice(prefix.length, -2))).state,
        "prepared"
      );
    } else {
      Assert.ok(!line, "First failed boundary did not replace prefs.js");
    }
    Assert.ok(
      persisted.includes(
        "user_pref(" + JSON.stringify(conflictPref) + ', "before");'
      ),
      "The failed snapshot never replaces the previous current preference file"
    );
    assertMigrationPublication(input, await input.adopt());
    Assert.deepEqual(
      input.events.map(([topic]) => topic),
      ["addrbook-directory-created"]
    );
    if (!obstructBackup) {
      Assert.ok(
        (await IOUtils.readUTF8(input.prefsFile.path)).includes(
          "user_pref(" + JSON.stringify(conflictPref) + ', "after");'
        ),
        "Exact retry durably includes the newer preference"
      );
    }
    input.events.length = 0;
    Assert.equal((await input.adopt()).reused, true);
    Assert.deepEqual(input.events, []);
  } finally {
    input.managerServices.prefs = prefs;
    if (obstruction?.exists()) {
      obstruction.remove(false);
    }
    if (temporary?.exists() && !temporary.equals(input.prefsFile)) {
      temporary.remove(false);
    }
    if (baseline.exists() && !baseline.equals(input.prefsFile)) {
      baseline.remove(false);
    }
    Services.prefs.clearUserPref(conflictPref);
    await input.cleanup();
  }
}

/**
 * Holds an actual backup completion while an owned callback has already ended.
 *
 * @param {boolean} callbackFails - Throw a real callback error before draining.
 * @param {boolean} [cancel=false] - Throw an actual aborted signal's reason.
 * @returns {Promise<void>} Pending adoption, original error and startup lock checked.
 */
async function assertMigrationOwnedPublicationSettlement(
  callbackFails,
  cancel = false
) {
  const input = await migrationPublicationInput();
  const prefs = input.managerServices.prefs;
  const backup = prefs.backupPrefFile;
  const originalStage = await IOUtils.read(input.options.stageFile.path);
  let enterBackup;
  const backupEntered = new Promise(resolve => {
    enterBackup = resolve;
  });
  let releaseBackup;
  const backupRelease = new Promise(resolve => {
    releaseBackup = resolve;
  });
  let reached = false;
  let publication;
  let adoption;
  let finished;
  let settled = false;
  const controller = new AbortController();
  controller.abort();
  const callbackError = cancel
    ? controller.signal.reason
    : new Error("Actual owned publication callback failure");
  try {
    input.managerServices.prefs = new Proxy(
      {},
      {
        get(target, name) {
          if (name == "backupPrefFile") {
            return file =>
              backup.call(prefs, file).then(async value => {
                if (!reached) {
                  reached = true;
                  enterBackup();
                  await backupRelease;
                }
                return value;
              });
          }
          const value = prefs[name];
          return typeof value == "function" ? value.bind(prefs) : value;
        },
      }
    );
    finished = input
      .run(active => {
        publication = active;
        adoption = active.adopt(input.options);
        if (callbackFails) {
          throw callbackError;
        }
        return "settled callback result";
      })
      .then(
        value => {
          settled = true;
          return { value };
        },
        error => {
          settled = true;
          return { error };
        }
      );
    // Unexpected early native failure stays an actual failure, not a timeout.
    await Promise.race([
      backupEntered,
      finished.then(outcome => {
        if (!reached) {
          throw outcome.error ?? new Error("Native backup was not reached");
        }
      }),
    ]);
    Assert.ok(
      reached,
      "Actual native backup completed before the held boundary"
    );
    Assert.ok(!settled, "Callback completion cannot abandon an adoption");
    Assert.throws(
      () => publication.checkProfile(),
      /Book publication operation is closed/
    );
    await Assert.rejects(
      publication.adopt(input.options),
      /Book publication operation is closed/
    );
    Assert.ok(!input.target.exists());
    Assert.deepEqual(input.events, []);
    releaseBackup();
    const outcome = await finished;
    const result = await adoption;
    if (callbackFails) {
      Assert.equal(
        outcome.error,
        callbackError,
        "First callback error identity"
      );
    } else {
      Assert.equal(outcome.value, "settled callback result");
      Assert.ok(!Object.hasOwn(outcome, "error"));
    }
    assertMigrationPublication(input, result);
    Assert.deepEqual(
      input.events.map(([topic]) => topic),
      ["addrbook-directory-created"]
    );
    Assert.deepEqual(
      await IOUtils.read(input.options.stageFile.path),
      originalStage
    );
    await assertMigrationStartupProfileHeld();
    Assert.ok(
      migrationPublicationStartupLock.directory.equals(do_get_profile())
    );
    input.events.length = 0;
    Assert.equal((await input.adopt()).reused, true);
    Assert.deepEqual(input.events, []);
  } finally {
    releaseBackup();
    await finished;
    await adoption?.catch(() => undefined);
    input.managerServices.prefs = prefs;
    await input.cleanup();
  }
}

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBookWithInterruptedPublication() {
    await assertMigrationOwnedPublicationSettlement(false);
    await assertMigrationOwnedPublicationSettlement(true);
    await assertMigrationOwnedPublicationSettlement(true, true);
    await assertMigrationPreferenceWriteFailure(false);
    await assertMigrationPreferenceWriteFailure(true);
    for (const atPublished of [false, true]) {
      await assertMigrationPreferenceSnapshotFailure(atPublished, true);
      await assertMigrationPreferenceSnapshotFailure(atPublished, false);
    }
    const input = await migrationPublicationInput();
    try {
      const first = await input.adopt();
      const pref = input.pref + ".panoramaMigration";
      const record = JSON.parse(Services.prefs.getStringPref(pref));
      record.state = "prepared";
      Services.prefs.setStringPref(pref, JSON.stringify(record));
      const saved = input.prefsFile.clone();
      saved.leafName += ".manager-fixture";
      saved.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
      try {
        await Services.prefs.backupPrefFile(saved);
        saved.moveTo(null, input.prefsFile.leafName);
      } finally {
        if (!saved.equals(input.prefsFile) && saved.exists()) {
          saved.remove(false);
        }
      }
      await reloadMigrationPublicationManager();
      Assert.ok(
        !MailServices.ab.directories.some(dir => dir.URI == first.uri),
        "Prepared complete copy is not enumerated as a live book"
      );
      input.events.length = 0;
      const result = await input.adopt();
      Assert.equal(result.uri, first.uri);
      assertMigrationPublication(input, result);
      Assert.deepEqual(
        input.events.map(([topic]) => topic),
        ["addrbook-directory-created"]
      );
      input.events.length = 0;
      Assert.equal((await input.adopt()).reused, true);
      Assert.deepEqual(input.events, []);
    } finally {
      await input.cleanup();
    }
  }
);

add_task(
  migrationPublicationOnly(),
  async function test_adoptMigrationAddressBookWithNotificationReentry() {
    const input = await migrationPublicationInput();
    const reentered = [];
    const errors = [];
    let activePublication;
    const observe = (subject, topic) => {
      if (
        topic == "addrbook-directory-created" &&
        subject.QueryInterface(Ci.nsIAbDirectory).UID == input.options.bookUID
      ) {
        try {
          reentered.push(
            activePublication
              .adopt(input.options)
              .catch(error => errors.push(error))
          );
        } catch (error) {
          errors.push(error);
        }
      }
    };
    Services.obs.addObserver(observe, "addrbook-directory-created");
    try {
      const result = await input.run(publication => {
        activePublication = publication;
        return publication.adopt(input.options);
      });
      const settled = await Promise.all(reentered);
      Assert.deepEqual(errors, []);
      Assert.equal(reentered.length, 1);
      Assert.equal(settled[0].directory, result.directory);
      Assert.equal(settled[0].reused, true);
      assertMigrationPublication(input, result);
      Assert.deepEqual(
        input.events.map(([topic]) => topic),
        ["addrbook-directory-created"]
      );
    } finally {
      Services.obs.removeObserver(observe, "addrbook-directory-created");
      await input.cleanup();
    }
  }
);
