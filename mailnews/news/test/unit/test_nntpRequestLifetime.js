/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { NntpClient } = ChromeUtils.importESModule(
  "resource:///modules/NntpClient.sys.mjs"
);
var { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

var server;
var incomingServer;

add_setup(function () {
  server = makeServer(NNTP_RFC2980_handler, setupNNTPDaemon());
  server.start();
  incomingServer = setupLocalServer(server.port);
  incomingServer.maximumConnectionsNumber = 1;
  registerCleanupFunction(() => {
    incomingServer.closeCachedConnections();
    server.stop();
  });
});

add_task(async function test_interruptedMultilineResponse() {
  incomingServer.closeCachedConnections();
  let requests = 0;
  class LargeListHandler extends NNTP_RFC2980_handler {
    LISTGROUP(group) {
      if (++requests == 1) {
        return (
          "211 Articles follow:\n" +
          Array.from({ length: 1001 }, (_, i) => `${i + 1}\n`).join("") +
          ".\n"
        );
      }
      return super.LISTGROUP(group);
    }
  }
  const raceServer = makeServer(LargeListHandler, setupNNTPDaemon());
  raceServer.start();
  incomingServer.port = raceServer.port;
  const pool = incomingServer.wrappedJSObject;
  let firstClient;
  let linesRead = 0;
  let oldRead;
  const reading = Promise.withResolvers();
  const interrupted = Promise.withResolvers();
  try {
    pool.withClient(client => {
      firstClient = client;
      client.startRunningUrl(null, null);
      const reader = client._lineReader;
      const read = reader.read.bind(reader);
      reader.read = (...args) => {
        const promise = read(...args);
        if (linesRead == 1000) {
          oldRead = promise;
          reading.resolve();
        }
        return promise;
      };
      client.onOpen = () => client.listgroup("test.filter");
      client.onData = () => {
        if (++linesRead == 1000) {
          setTimeout(() => client.quit(Cr.NS_ERROR_NET_RESET));
        }
      };
      client.onDone = status => {
        interrupted.resolve(status);
      };
    });
    const next = new Promise(resolve => {
      pool.withClient(client => {
        Assert.equal(
          client,
          firstClient,
          "the queued request should reuse the client"
        );
        client.startRunningUrl(null, null);
        const lines = [];
        client.onOpen = () => client.listgroup("test.filter");
        client.onData = line => lines.push(line.trim());
        client.onDone = status => resolve({ status, lines });
      });
    });
    await reading.promise;
    Assert.equal(
      await interrupted.promise,
      Cr.NS_ERROR_NET_RESET,
      "the interrupted request should retain its network failure"
    );
    await oldRead;
    const result = await next;
    Assert.equal(
      linesRead,
      1000,
      "the old request should receive no more data after completion"
    );
    Assert.equal(result.status, Cr.NS_OK, "the queued request should succeed");
    Assert.deepEqual(
      result.lines,
      ["1", "2", "3", "4", "5", "6", "7", "8"],
      "the queued request should receive only its own response"
    );
    Assert.equal(
      requests,
      2,
      "the queued request should complete its own server command"
    );
  } finally {
    incomingServer.closeCachedConnections();
    await raceServer.stop();
    incomingServer.port = server.port;
  }
});

add_task(async function test_staleReaderRejection() {
  const client = new NntpClient(incomingServer);
  const socket = () => ({
    readyState: "open",
    close() {
      this.readyState = "closed";
    },
  });
  client._socket = socket();
  client.connect();
  const pending = Promise.withResolvers();
  client._lineReader = { read: () => pending.promise };
  let oldCallbacks = 0;
  const processing = client._readResponse(
    "",
    () => oldCallbacks++,
    () => oldCallbacks++
  );
  client._actionDone(Cr.NS_ERROR_NET_RESET);

  client._socket = socket();
  client.connect();
  const reader = client._lineReader;
  let completions = 0;
  client.onDone = () => completions++;
  pending.reject(new Error("Old response failed after client reuse"));
  await processing;
  Assert.equal(oldCallbacks, 0, "stale response callbacks should not run");
  Assert.equal(
    client._lineReader,
    reader,
    "a stale rejection should not replace the current reader"
  );
  Assert.ok(
    !client._done,
    "a stale rejection should not complete the new request"
  );
  Assert.equal(
    completions,
    0,
    "a stale rejection should not notify the new request's observers"
  );
  client._actionDone();
});


add_task(function test_reentrantCompletionRetainsNewRequest() {
  const client = new NntpClient(incomingServer);
  const socket = { readyState: "open", close() {} };
  client._socket = socket;
  client.connect();
  const stops = [];
  const oldUrl = client.startRunningUrl({
    OnStartRunningUrl() {},
    OnStopRunningUrl(url, status) {
      stops.push([url, status]);
    },
  }, null);
  let oldDone = 0;
  let newDone = 0;
  let idle = 0;
  let newUrl;
  client.onIdle = () => idle++;
  client.onDone = status => {
    oldDone++;
    Assert.equal(status, Cr.NS_ERROR_NET_RESET);
    newUrl = client.startRunningUrl(null, null);
    client.onDone = () => newDone++;
    client.connect();
  };
  client._actionDone(Cr.NS_ERROR_NET_RESET);
  Assert.equal(oldDone, 1);
  Assert.deepEqual(stops, [[oldUrl, Cr.NS_ERROR_NET_RESET]], "Old URL callbacks use only their captured context");
  Assert.equal(client.runningUri, newUrl, "Old completion cannot clear the reentrant URL");
  Assert.ok(!client._done, "The reentrant request is still active");
  Assert.equal(idle, 0, "The connection stays owned by the reentrant request");
  client._actionDone();
  client._actionDone();
  Assert.equal(newDone, 1);
  Assert.equal(idle, 1, "The new request releases its connection once");
});

add_task(async function test_closedResponseFinishesOnce() {
  const client = new NntpClient(incomingServer);
  client._socket = { readyState: "open", close() {} };
  client.connect();
  const statuses = [];
  let idle = 0;
  client.onDone = status => statuses.push(status);
  client.onIdle = () => idle++;
  await client._onClose();
  await client._onClose();
  Assert.deepEqual(statuses, [Cr.NS_ERROR_NET_RESET], "An incomplete response cannot finish successfully on close");
  Assert.equal(idle, 1);
});


add_task(async function test_staleCloseDoesNotFinishReusedClient() {
  const client = new NntpClient(incomingServer);
  const oldSocket = { readyState: "open", close() {} };
  client._socket = oldSocket;
  client.connect();
  const pending = Promise.withResolvers();
  client._promiseErrorHandled = pending.promise;
  const closing = client._onClose({ target: oldSocket });
  client._actionDone(Cr.NS_ERROR_NET_RESET);
  client._socket = { readyState: "open", close() {} };
  client.connect();
  const newError = Promise.resolve();
  client._promiseErrorHandled = newError;
  let completions = 0;
  client.onDone = () => completions++;
  pending.resolve();
  await closing;
  await client._onClose({ target: oldSocket });
  Assert.ok(!client._done, "Neither an awaited nor late old close can finish the new request");
  Assert.equal(completions, 0);
  Assert.equal(client._promiseErrorHandled, newError, "Old close cannot clear new error ownership");
  client._actionDone();
  Assert.equal(completions, 1);
});
