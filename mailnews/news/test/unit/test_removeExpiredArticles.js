/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { NntpNewsGroup } = ChromeUtils.importESModule(
  "resource:///modules/NntpNewsGroup.sys.mjs"
);

var incomingServer;
var folder;
var articleKeys;
let expiryFixtureId = 0;
const nativeBackend = Services.prefs.getBoolPref(
  "mail.panorama.enabled",
  false
);

/**
 * Populate real group articles and run a test against a fresh server/account.
 *
 * @param {typeof NNTP_RFC977_handler} handler - The server handler class.
 * @param {function(nsMailServer): Promise<void>} testFn - The test to run.
 */
async function withServer(handler, testFn) {
  const server = makeServer(handler, setupNNTPDaemon());
  server.start();
  const created = localAccountUtils.create_incoming_server_and_account(
    "nntp",
    server.port,
    `expiry-${expiryFixtureId++}`,
    null,
    "localhost"
  );
  incomingServer = created.server.QueryInterface(Ci.nsINntpIncomingServer);
  incomingServer.pushAuth = false;
  subscribeServer(incomingServer);
  folder = incomingServer.rootFolder
    .getChildNamed("test.filter")
    .QueryInterface(Ci.nsIMsgNewsFolder);
  try {
    const db = folder.msgDatabase;
    if (nativeBackend) {
      // A real producer in another group consumes the first global physical
      // key so none of this group's keys can alias its wire articles 1,2,3.
      const other = incomingServer.rootFolder
        .getChildNamed("test.subscribe.simple")
        .QueryInterface(Ci.nsIMsgNewsFolder);
      const seed = new NntpNewsGroup(incomingServer, other);
      try {
        seed.getArticlesRangeToFetch(null, 1, 1);
        seed.processXOverLine(
          "1\tIndependent expiry group\tReader <reader@example.invalid>\tThu, 01 Oct 2026 12:00:00 +0000\t<expiry-seed@expired.invalid>\t\t20\t1"
        );
        seed.finishProcessingXOver();
      } finally {
        seed.cleanUp();
      }
      const reader = new NntpNewsGroup(incomingServer, folder);
      try {
        reader.getArticlesRangeToFetch(null, 1, 3);
        for (const article of [1, 2, 3]) {
          reader.processXOverLine(
            `${article}\tExpiry ${article}\tReader <reader@example.invalid>\tThu, 01 Oct 2026 12:00:00 +0000\t<${article}@expired.invalid>\t\t20\t1`
          );
        }
        reader.finishProcessingXOver();
      } finally {
        reader.cleanUp();
      }
    } else {
      for (const key of [1, 2, 3]) {
        const header = db.createNewHdrWithSpecificMsgKey(key);
        header.messageId = `${key}@expired.invalid`;
        db.attachHdr(header, true);
      }
    }
    articleKeys = [1, 2, 3].map(article => {
      const header = db.getMsgHdrForMessageID(`${article}@expired.invalid`);
      Assert.ok(header, "The ordinary group producer published this article");
      if (nativeBackend) {
        Assert.notEqual(
          header.messageKey,
          article,
          "Native physical key differs from the wire article"
        );
      }
      return header.messageKey;
    });
    await testFn(server);
  } finally {
    incomingServer.closeCachedConnections();
    await server.stop();
    MailServices.accounts.removeAccount(created.account, false);
  }
}

add_task(async function test_removeExpiredArticles() {
  class ListHandler extends NNTP_RFC977_handler {
    LISTGROUP() {
      return "211 Articles follow:\n1\n3\n.\n";
    }
  }
  await withServer(ListHandler, async server => {
    await incomingServer.wrappedJSObject.removeExpiredArticles("test.filter");
    Assert.deepEqual(
      folder.msgDatabase.listAllKeys(),
      [articleKeys[0], articleKeys[2]],
      "a successful list should remove only articles absent from the server"
    );
    Assert.deepEqual(
      server.playTransaction().them,
      ["MODE READER", "LISTGROUP test.filter"],
      "expiration should request the server's article list"
    );
  });
});

add_task(async function test_failedListPreservesHeaders() {
  class ErrorHandler extends NNTP_RFC977_handler {
    LISTGROUP() {
      return "501 LISTGROUP failed";
    }
  }
  await withServer(ErrorHandler, async () => {
    await Assert.rejects(
      incomingServer.wrappedJSObject.removeExpiredArticles("test.filter"),
      /NS_ERROR_FAILURE/,
      "a failed list should reject with the request status"
    );
    Assert.deepEqual(
      folder.msgDatabase.listAllKeys(),
      articleKeys,
      "a failed list should preserve every local header"
    );
  });
});

/**
 * Pause LISTGROUP before its terminator and interrupt the request.
 *
 * @param {function(NntpClient): void} interrupt - End the request.
 * @param {RegExp} expectedError - The expected rejection from the request.
 * @returns {Promise<{client: NntpClient, statuses: nsresult[]}>} The completed
 *   client and its completion notifications.
 */
async function interruptList(interrupt, expectedError) {
  const received = Promise.withResolvers();
  class PartialListHandler extends NNTP_RFC977_handler {
    LISTGROUP() {
      return "211 Articles follow:\n1\n";
    }
  }
  let client;
  const statuses = [];
  await withServer(PartialListHandler, async () => {
    const pool = incomingServer.wrappedJSObject;
    const withClient = pool.withClient;
    pool.withClient = handler =>
      withClient.call(pool, connection => {
        client = connection;
        handler(client);
        const reader = client._lineReader;
        const read = reader.read.bind(reader);
        reader.read = (...args) => {
          const result = read(...args);
          received.resolve();
          return result;
        };
        const onDone = client.onDone;
        client.onDone = status => {
          statuses.push(status);
          onDone(status);
        };
      });
    let operation;
    try {
      operation = pool.removeExpiredArticles("test.filter");
      await received.promise;
    } finally {
      pool.withClient = withClient;
    }
    interrupt(client);
    await Assert.rejects(
      operation,
      expectedError,
      "an interrupted list should reject with the request status"
    );
    Assert.deepEqual(
      folder.msgDatabase.listAllKeys(),
      articleKeys,
      "an interrupted list should preserve every local header"
    );
    Assert.equal(
      pool._busyConnections.length,
      0,
      "the interrupted operation should release its busy connection"
    );
  });
  return { client, statuses };
}

add_task(async function test_connectionFailurePreservesHeaders() {
  const { statuses } = await interruptList(
    client =>
      client._onError({
        target: client._socket,
        errorCode: Cr.NS_ERROR_NET_RESET,
        name: "NetworkError",
        message: "Connection reset during LISTGROUP",
      }),
    /NS_ERROR_NET_RESET/
  );
  Assert.deepEqual(
    statuses,
    [Cr.NS_ERROR_NET_RESET],
    "a connection failure should complete once with the network error"
  );
});

add_task(async function test_shutdownPreservesHeaders() {
  let releases = 0;
  const { statuses } = await interruptList(client => {
    const onIdle = client.onIdle;
    client.onIdle = () => {
      releases++;
      onIdle();
    };
    incomingServer.closeCachedConnections();
    incomingServer.closeCachedConnections();
    Assert.notEqual(
      client._socket.readyState,
      "open",
      "shutdown should close the interrupted connection"
    );
  }, /NS_ERROR_ABORT/);
  Assert.deepEqual(
    statuses,
    [Cr.NS_ERROR_ABORT],
    "shutdown should complete the unfinished request once with an abort status"
  );
  Assert.equal(releases, 1, "shutdown should release the connection once");
  Assert.equal(
    incomingServer.wrappedJSObject._idleConnections.length,
    0,
    "shutdown should leave no cached connection"
  );
});

add_task(async function test_nativeMalformedListPreservesState() {
  if (!nativeBackend) {
    info("Mapped native LISTGROUP validation is inapplicable to Mork");
    return;
  }
  class MalformedListHandler extends NNTP_RFC977_handler {
    LISTGROUP() {
      return "211 Articles follow:\n1\nnot-an-article\n.\n";
    }
  }
  await withServer(MalformedListHandler, async () => {
    const db = folder.msgDatabase;
    const flags = articleKeys.map(key => db.getMsgHdrForKey(key).flags);
    const newsrc = folder.newsrcLine;
    const known = db.dBFolderInfo.knownArtsSet;
    await Assert.rejects(
      incomingServer.wrappedJSObject.removeExpiredArticles(folder.name),
      /NS_ERROR_ILLEGAL_VALUE/,
      "Malformed server article data preserves the original parse error"
    );
    Assert.deepEqual(
      db.listAllKeys(),
      articleKeys,
      "Parsing failure removes no physical header"
    );
    Assert.deepEqual(
      articleKeys.map(key => db.getMsgHdrForKey(key).flags),
      flags
    );
    Assert.equal(folder.newsrcLine, newsrc);
    Assert.equal(db.dBFolderInfo.knownArtsSet, known);
  });
});

add_task(async function test_nativeClosedListSnapshotPreservesHeaders() {
  if (!nativeBackend) {
    info("Native captured-facade validation is inapplicable to Mork");
    return;
  }
  class ListHandler extends NNTP_RFC977_handler {
    LISTGROUP() {
      return "211 Articles follow:\n1\n.\n";
    }
  }
  await withServer(ListHandler, async () => {
    const db = folder.msgDatabase;
    const newsrc = folder.newsrcLine;
    const pool = incomingServer.wrappedJSObject;
    const withClient = pool.withClient;
    let completions = 0;
    pool.withClient = handler =>
      withClient.call(pool, client => {
        handler(client);
        const onDone = client.onDone;
        client.onDone = status => {
          completions++;
          Assert.equal(
            status,
            Cr.NS_OK,
            "The real server list completed before invalidation"
          );
          db.forceClosed();
          onDone(status);
        };
      });
    try {
      await Assert.rejects(
        pool.removeExpiredArticles(folder.name),
        /NS_ERROR_NOT_AVAILABLE/,
        "A closed captured facade prevents the entire prune"
      );
    } finally {
      pool.withClient = withClient;
    }
    Assert.equal(completions, 1, "LISTGROUP completes once");
    Assert.deepEqual(
      folder.msgDatabase.listAllKeys(),
      articleKeys,
      "A stale list removes no physical header"
    );
    Assert.equal(folder.newsrcLine, newsrc);
  });
});
