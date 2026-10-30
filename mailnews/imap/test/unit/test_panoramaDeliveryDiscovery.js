/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head_server.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

let fixture;

add_setup(function setupDiscovery() {
  const lane = PanoramaDelivery.expectedLane();
  info(
    "DELIVERY_IMAP_FIXTURE " +
      JSON.stringify({ ...lane, mode: "preconfigured-store", discoveryCase })
  );
  fixture = PanoramaDelivery.createImapFixture();
});

/**
 * Seeds only the server. The client must learn these folders through LIST/LSUB.
 *
 * @param {boolean} nested - Whether to include a nested mailbox.
 */
function seedMailboxes(nested) {
  const { daemon, rootFolder } = fixture;
  Assert.equal(rootFolder.getChildNamed("DeliveryParent"), null);
  daemon.createMailbox("DeliveryParent", { subscribed: true });
  if (nested) {
    daemon.createMailbox("DeliveryParent/DeliveryChild", { subscribed: true });
  }
  Assert.deepEqual(
    daemon.root.allChildren.map(mailbox => mailbox.fullName).sort(),
    nested
      ? ["DeliveryParent", "DeliveryParent/DeliveryChild", "INBOX"]
      : ["DeliveryParent", "INBOX"],
    "The fake server has exactly the intended mailbox hierarchy"
  );
}

/**
 * Runs production discovery and verifies actual mailbox listing commands.
 */
async function discover() {
  info('DELIVERY_PHASE {"phase":"imap-discovery-started"}');
  const listingCount = () =>
    [fixture.server.playTransaction()]
      .flat()
      .reduce(
        (count, transaction) =>
          count +
          transaction.them.filter(line => /^\S+ (LIST|LSUB) /i.test(line))
            .length,
        0
      );
  const previousListings = listingCount();
  const listener = new PromiseTestUtils.PromiseUrlListener();
  MailServices.imap.discoverAllFolders(fixture.rootFolder, listener, null);
  try {
    await listener.promise;
  } finally {
    Assert.greater(
      listingCount(),
      previousListings,
      "Discovery reached the fake server's mailbox listing commands"
    );
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-url-complete"}');
}

/**
 * Checks a server-discovered child without creating a client folder.
 *
 * @param {nsIMsgFolder} parent - The expected client parent.
 * @param {string} name - The literal leaf name.
 * @param {string} uri - The expected URI.
 * @returns {nsIMsgImapMailFolder} The discovered protocol folder.
 */
function discoveredChild(parent, name, uri) {
  const folder = parent.getChildNamed(name);
  Assert.ok(folder, "Discovery materialized " + uri);
  folder.QueryInterface(Ci.nsIMsgImapMailFolder);
  Assert.equal(folder.parent, parent, "The discovered parent is preserved");
  Assert.equal(folder.server, fixture.incomingServer);
  Assert.equal(folder.name, name);
  Assert.equal(folder.URI, uri);
  Assert.equal(MailServices.folderLookup.getFolderForURL(uri), folder);
  Assert.equal(
    parent.subFolders.filter(child => child.name == name).length,
    1,
    "The parent exposes exactly one child with this name"
  );
  if (fixture.core) {
    Assert.greater(folder.id, 0, "The discovered child has a Panorama ID");
    Assert.equal(
      fixture.core.folderDB.getFolderChildNamed(parent.id, name),
      folder.id,
      "The persisted hierarchy identifies the discovered child"
    );
    Assert.equal(
      fixture.core.folderDB.getMsgFolderForFolder(folder.id),
      folder
    );
  }
  return folder;
}

async function test_discoversChild() {
  seedMailboxes(false);
  await discover();
  const folder = discoveredChild(
    fixture.rootFolder,
    "DeliveryParent",
    fixture.rootFolder.URI + "/DeliveryParent"
  );
  PanoramaDelivery.assertFolder(folder, fixture.lane);
  info('DELIVERY_PHASE {"phase":"imap-discovery-child-verified"}');
}

async function test_discoversNestedChild() {
  seedMailboxes(true);
  await discover();
  const parent = discoveredChild(
    fixture.rootFolder,
    "DeliveryParent",
    fixture.rootFolder.URI + "/DeliveryParent"
  );
  const child = discoveredChild(
    parent,
    "DeliveryChild",
    fixture.rootFolder.URI + "/DeliveryParent/DeliveryChild"
  );
  Assert.deepEqual(child.subFolders, [], "The nested mailbox has no children");
  PanoramaDelivery.assertFolder(parent, fixture.lane);
  PanoramaDelivery.assertFolder(child, fixture.lane);
  info('DELIVERY_PHASE {"phase":"imap-discovery-nested-verified"}');
}

async function test_repeatedDiscoveryPreservesIdentity() {
  seedMailboxes(true);
  await discover();
  const root = fixture.rootFolder;
  const parent = discoveredChild(
    root,
    "DeliveryParent",
    root.URI + "/DeliveryParent"
  );
  const child = discoveredChild(
    parent,
    "DeliveryChild",
    root.URI + "/DeliveryParent/DeliveryChild"
  );
  const ids = fixture.core ? [parent.id, child.id] : null;
  const rootChildren = root.subFolders;
  const nestedChildren = parent.subFolders;
  info('DELIVERY_PHASE {"phase":"imap-discovery-repeat-ready"}');
  await discover();
  Assert.equal(
    discoveredChild(root, "DeliveryParent", root.URI + "/DeliveryParent"),
    parent,
    "Repeated discovery retains the parent object"
  );
  Assert.equal(
    discoveredChild(
      parent,
      "DeliveryChild",
      root.URI + "/DeliveryParent/DeliveryChild"
    ),
    child,
    "Repeated discovery retains the nested object"
  );
  Assert.deepEqual(
    root.subFolders.map(folder => folder.URI).sort(),
    rootChildren.map(folder => folder.URI).sort(),
    "Repeated discovery adds no root children"
  );
  Assert.deepEqual(
    parent.subFolders.map(folder => folder.URI).sort(),
    nestedChildren.map(folder => folder.URI).sort(),
    "Repeated discovery adds no nested children"
  );
  if (ids) {
    Assert.deepEqual(
      [parent.id, child.id],
      ids,
      "Repeated discovery retains the persisted folder identities"
    );
  }
  PanoramaDelivery.assertFolder(parent, fixture.lane);
  PanoramaDelivery.assertFolder(child, fixture.lane);
  if (fixture.core) {
    const parentPath = parent.filePath;
    const childPath = child.filePath.path;
    const unsupportedPath = parentPath.clone();
    unsupportedPath.leafName = "DifferentDeliveryParent";
    let retryId;
    parent.filePath = unsupportedPath;
    try {
      fixture.daemon.createMailbox("DeliveryParent/DeliveryRetry", {
        subscribed: true,
      });
      Assert.deepEqual(
        fixture.daemon.root.allChildren.map(mailbox => mailbox.fullName).sort(),
        [
          "DeliveryParent",
          "DeliveryParent/DeliveryChild",
          "DeliveryParent/DeliveryRetry",
          "INBOX",
          "Trash",
        ]
      );
      await Assert.rejects(
        discover(),
        error => error.message == String(Cr.NS_ERROR_NOT_IMPLEMENTED),
        "The unsupported effective parent path reports its original error"
      );
      Assert.equal(
        parent.getChildNamed("DeliveryRetry"),
        null,
        "An unsupported effective parent path cannot publish a child"
      );
      retryId = fixture.core.folderDB.getFolderChildNamed(
        parent.id,
        "DeliveryRetry"
      );
      Assert.greater(
        retryId,
        0,
        "The server-known row survives the failed attempt"
      );
      Assert.equal(
        MailServices.folderLookup.getFolderForURL(
          parent.URI + "/DeliveryRetry"
        ),
        null,
        "The failed object is absent from the live folder cache"
      );
      Assert.equal(parent.getChildNamed("DeliveryChild"), child);
      Assert.equal(child.filePath.path, childPath);
    } finally {
      parent.filePath = parentPath;
    }
    await discover();
    const retry = discoveredChild(
      parent,
      "DeliveryRetry",
      parent.URI + "/DeliveryRetry"
    );
    Assert.equal(
      retry.id,
      retryId,
      "Retry materializes the retained server row"
    );
    Assert.equal(retry.onlineName, "DeliveryParent/DeliveryRetry");
    Assert.equal(retry.hierarchyDelimiter, "/");
    const expectedPath = parentPath.clone();
    expectedPath.leafName += ".sbd";
    expectedPath.append("DeliveryRetry");
    Assert.ok(retry.filePath.equals(expectedPath));
    PanoramaDelivery.assertFolder(retry, fixture.lane);
    await discover();
    Assert.equal(parent.getChildNamed("DeliveryRetry"), retry);
    Assert.equal(parent.getChildNamed("DeliveryChild"), child);
    Assert.equal(child.filePath.path, childPath);
    Assert.deepEqual([parent.id, child.id], ids);
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-repeat-verified"}');
}

async function test_discoveryStoresOnlineName() {
  seedMailboxes(true);
  await discover();
  const parent = discoveredChild(
    fixture.rootFolder,
    "DeliveryParent",
    fixture.rootFolder.URI + "/DeliveryParent"
  );
  const child = discoveredChild(
    parent,
    "DeliveryChild",
    fixture.rootFolder.URI + "/DeliveryParent/DeliveryChild"
  );
  PanoramaDelivery.assertFolder(child, fixture.lane);
  Assert.equal(child.onlineName, "DeliveryParent/DeliveryChild");
  child.ForceDBClosed();
  const db = PanoramaDelivery.assertFolder(child, fixture.lane);
  Assert.equal(
    db.dBFolderInfo.getCharProperty("onlineName"),
    "DeliveryParent/DeliveryChild",
    "The stored online-name property retains the complete server mailbox name"
  );
  info('DELIVERY_PHASE {"phase":"imap-discovery-online-property-verified"}');
  Assert.equal(
    db.dBFolderInfo.mailboxName,
    "DeliveryParent/DeliveryChild",
    "The mailbox-name accessor retains the complete server mailbox name"
  );
  info('DELIVERY_PHASE {"phase":"imap-discovery-online-name-verified"}');
}

async function test_discoveryReportsDelimiter() {
  seedMailboxes(true);
  await discover();
  const parent = discoveredChild(
    fixture.rootFolder,
    "DeliveryParent",
    fixture.rootFolder.URI + "/DeliveryParent"
  );
  const child = discoveredChild(
    parent,
    "DeliveryChild",
    fixture.rootFolder.URI + "/DeliveryParent/DeliveryChild"
  );
  Assert.equal(fixture.daemon.getMailbox("DeliveryParent").delimiter, "/");
  Assert.equal(
    fixture.daemon.getMailbox("DeliveryParent/DeliveryChild").delimiter,
    "/"
  );
  Assert.equal(parent.hierarchyDelimiter, "/");
  Assert.equal(child.hierarchyDelimiter, "/");
  const parentDB = PanoramaDelivery.assertFolder(parent, fixture.lane);
  const childDB = PanoramaDelivery.assertFolder(child, fixture.lane);
  if (fixture.core) {
    Assert.equal(parentDB.dBFolderInfo.getUint32Property("hierDelim", 0), 47);
    Assert.equal(childDB.dBFolderInfo.getUint32Property("hierDelim", 0), 47);
  }
  info('DELIVERY_PHASE {"phase":"imap-discovery-delimiter-verified"}');
}

// Each manual manifest selects one task in a fresh process. No skipped tasks.
const discoveryCase = Services.prefs.getStringPref(
  "mail.test.panorama.discovery_case"
);
const discoveryTasks = {
  child: test_discoversChild,
  nested: test_discoversNestedChild,
  repeat: test_repeatedDiscoveryPreservesIdentity,
  "online-name": test_discoveryStoresOnlineName,
  delimiter: test_discoveryReportsDelimiter,
};
if (!Object.hasOwn(discoveryTasks, discoveryCase)) {
  throw new Error("Unsupported IMAP discovery case: " + discoveryCase);
}
add_task(discoveryTasks[discoveryCase]);
