/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../db/panorama/test/xpcshell/head.js */
/* import-globals-from ../../../db/panorama/test/xpcshell/head_delivery.js */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/PromiseTestUtils.sys.mjs"
);

const mailboxWitnessContract =
  "@mozilla.org/messenger/messageservice;1?type=mailbox";
const witnessStoreContracts = {
  mbox: "@mozilla.org/msgstore/berkeleystore;1",
  maildir: "@mozilla.org/msgstore/maildirstore;1",
};
const witnessStoreCIDs = {
  mbox: "{36358199-a0e4-4b68-929f-77c01de34c67}",
  maildir: "{1f993eda-7dd9-11df-819a-6257dfd72085}",
};

/** @type {{rootFolder: nsIMsgLocalMailFolder}} */
let witnessFixture;
/** @type {object|null} Observations for the currently running task. */
let currentWitness = null;
const witnessStates = [];
const witnessRegistrations = [];
let witnessStoreInstances = 0;

/**
 * Records a native callback or provider call without asserting in its stack.
 *
 * @param {object} state - The current task's observations.
 * @param {string} type - The observed call or return.
 * @param {object} [details={}] - Arguments and results needed by the assertions.
 * @returns {object} The event with its position in the trace.
 */
function recordMailboxWitness(state, type, details = {}) {
  const event = { seq: state.events.length, type, ...details };
  state.events.push(event);
  return event;
}

/**
 * Forwards the native stream listener, observing only protocol-driven calls.
 *
 * @param {nsIStreamListener} original - The real CopyMessageStreamListener.
 * @param {object} state - The current task's observations.
 * @param {object} request - The matched real CopyMessages invocation.
 * @returns {nsIStreamListener} The forwarding listener.
 */
function observeMailboxListener(original, state, request) {
  const copy = original.QueryInterface(Ci.nsICopyMessageListener);
  return {
    QueryInterface: ChromeUtils.generateQI([
      "nsIStreamListener",
      "nsIRequestObserver",
      "nsICopyMessageListener",
    ]),
    onStartRequest(nativeRequest) {
      recordMailboxWitness(state, "stream-start", {
        id: request.id,
        nativeRequest,
      });
      return original.onStartRequest(nativeRequest);
    },
    onDataAvailable(nativeRequest, input, offset, count) {
      return original.onDataAvailable(nativeRequest, input, offset, count);
    },
    onStopRequest(nativeRequest, status) {
      recordMailboxWitness(state, "final-stop-entry", {
        id: request.id,
        nativeRequest,
        status,
      });
      try {
        return original.onStopRequest(nativeRequest, status);
      } finally {
        recordMailboxWitness(state, "final-stop-exit", { id: request.id });
        request.settled();
      }
    },
    beginCopy() {
      return copy.beginCopy();
    },
    startMessage() {
      const member = request.nextMember++;
      const previous = state.memberScope;
      state.memberScope = { id: request.id, member };
      recordMailboxWitness(state, "member-start-entry", {
        id: request.id,
        member,
      });
      try {
        return copy.startMessage();
      } catch (error) {
        recordMailboxWitness(state, "member-start-error", {
          id: request.id,
          member,
          result: error.result,
        });
        throw error;
      } finally {
        recordMailboxWitness(state, "member-start-exit", {
          id: request.id,
          member,
        });
        state.memberScope = previous;
      }
    },
    copyData(input, length) {
      return copy.copyData(input, length);
    },
    endMessage(key) {
      return copy.endMessage(key);
    },
    endCopy(succeeded) {
      return copy.endCopy(succeeded);
    },
    endMove(succeeded) {
      return copy.endMove(succeeded);
    },
  };
}

/**
 * Forwards the complete nsIMsgMessageService interface to the retained service.
 *
 * @param {nsIMsgMessageService} native - The service retained before remapping.
 * @returns {nsIMsgMessageService} The service observing matched requests only.
 */
function observeMailboxService(native) {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgMessageService"]),
    copyMessage(...args) {
      return native.copyMessage(...args);
    },
    CopyMessages(keys, source, listener, move, urlListener, msgWindow) {
      const state = currentWitness;
      const expected = state?.expectedRequests.find(
        item =>
          item.uri == source.URI &&
          item.keys.length == keys.length &&
          item.keys.every((key, index) => key == keys[index])
      );
      if (!expected) {
        return native.CopyMessages(
          keys,
          source,
          listener,
          move,
          urlListener,
          msgWindow
        );
      }
      // Initial StartMessage ran before CopyMessagesTo called this service.
      const request = { id: expected.id, nextMember: 2 };
      request.finished = new Promise(resolve => {
        request.settled = resolve;
      });
      state.requests.push(request);
      recordMailboxWitness(state, "service-copy", {
        id: request.id,
        keys: Array.from(keys),
        move,
        urlListener,
        msgWindow,
      });
      const observed = observeMailboxListener(listener, state, request);
      try {
        return native.CopyMessages(
          keys,
          source,
          observed,
          move,
          urlListener,
          msgWindow
        );
      } catch (error) {
        recordMailboxWitness(state, "service-copy-error", {
          id: request.id,
          result: error.result,
        });
        request.settled();
        throw error;
      }
    },
    loadMessage(...args) {
      return native.loadMessage(...args);
    },
    saveMessageToDisk(...args) {
      return native.saveMessageToDisk(...args);
    },
    getUrlForUri(...args) {
      return native.getUrlForUri(...args);
    },
    Search(...args) {
      return native.Search(...args);
    },
    streamMessage(...args) {
      return native.streamMessage(...args);
    },
    streamHeaders(...args) {
      return native.streamHeaders(...args);
    },
    isMsgInMemCache(...args) {
      return native.isMsgInMemCache(...args);
    },
    messageURIToMsgHdr(...args) {
      return native.messageURIToMsgHdr(...args);
    },
  };
}

/**
 * Forwards every store method and out parameter to one genuine native store.
 * Output streams are never wrapped or substituted.
 *
 * @param {nsIMsgPluggableStore} native - A fresh instance of the original CID.
 * @returns {nsIMsgPluggableStore} The forwarding store.
 */
function observeMailboxStore(native) {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgPluggableStore"]),
    discoverSubFolders(...args) {
      return native.discoverSubFolders(...args);
    },
    discoverChildFolders(...args) {
      return native.discoverChildFolders(...args);
    },
    createFolder(...args) {
      return native.createFolder(...args);
    },
    ensureLocalStore(...args) {
      return native.ensureLocalStore(...args);
    },
    deleteFolder(...args) {
      return native.deleteFolder(...args);
    },
    renameFolder(...args) {
      return native.renameFolder(...args);
    },
    hasSpaceAvailable(...args) {
      return native.hasSpaceAvailable(...args);
    },
    copyFolder(...args) {
      return native.copyFolder(...args);
    },
    getNewMsgOutputStream(folder) {
      const state = currentWitness;
      const event =
        state && folder.URI == state.destinationURI
          ? recordMailboxWitness(state, "destination-open-entry", {
              scope: state.memberScope,
            })
          : null;
      try {
        const stream = native.getNewMsgOutputStream(folder);
        if (event) {
          event.stream = stream;
        }
        return stream;
      } catch (error) {
        if (event) {
          event.result = error.result;
        }
        throw error;
      }
    },
    finishNewMessage(folder, stream) {
      const state = currentWitness;
      const observing = state && folder.URI == state.destinationURI;
      if (observing) {
        recordMailboxWitness(state, "finish-entry", { stream });
      }
      try {
        const token = native.finishNewMessage(folder, stream);
        if (observing) {
          recordMailboxWitness(state, "finish-success", { stream, token });
        }
        return token;
      } catch (error) {
        if (observing) {
          recordMailboxWitness(state, "finish-error", {
            stream,
            result: error.result,
          });
        }
        throw error;
      }
    },
    discardNewMessage(...args) {
      return native.discardNewMessage(...args);
    },
    getMsgInputStream(...args) {
      return native.getMsgInputStream(...args);
    },
    deleteMessages(...args) {
      return native.deleteMessages(...args);
    },
    deleteStoreMessages(...args) {
      return native.deleteStoreMessages(...args);
    },
    copyMessages(isMove, headers, destination, destinationHeaders, undoAction) {
      return native.copyMessages(
        isMove,
        headers,
        destination,
        destinationHeaders,
        undoAction
      );
    },
    get supportsCompaction() {
      return native.supportsCompaction;
    },
    asyncCompact(...args) {
      return native.asyncCompact(...args);
    },
    isSummaryFileValid(...args) {
      return native.isSummaryFileValid(...args);
    },
    setSummaryFileValid(...args) {
      return native.setSummaryFileValid(...args);
    },
    asyncScan(...args) {
      return native.asyncScan(...args);
    },
    changeFlags(...args) {
      return native.changeFlags(...args);
    },
    changeKeywords(...args) {
      return native.changeKeywords(...args);
    },
    estimateFolderSize(...args) {
      return native.estimateFolderSize(...args);
    },
    get storeType() {
      return native.storeType;
    },
  };
}

add_setup(function setupLocalPublicationWitness() {
  const lane = PanoramaDelivery.expectedLane();
  Assert.equal(lane.backend, "panorama");
  Assert.ok(Object.hasOwn(witnessStoreContracts, lane.store));
  const storeContract = witnessStoreContracts[lane.store];
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  const serviceCID = registrar.contractIDToCID(mailboxWitnessContract);
  const storeCID = registrar.contractIDToCID(storeContract);
  Assert.equal(serviceCID.toString(), "{eef82462-cb69-11d2-8065-006008128c4e}");
  Assert.equal(storeCID.toString(), witnessStoreCIDs[lane.store]);
  const nativeService = Cc[mailboxWitnessContract].getService(
    Ci.nsIMsgMessageService
  );

  // Restore only these registrations, after all forwarded stop stacks returned.
  registerCleanupFunction(async () => {
    for (const state of witnessStates) {
      await Promise.all(state.requests.map(request => request.finished));
    }
    while (witnessRegistrations.length) {
      MockRegistrar.unregister(witnessRegistrations.pop());
    }
    Assert.equal(
      registrar.contractIDToCID(mailboxWitnessContract).toString(),
      serviceCID.toString()
    );
    Assert.equal(
      registrar.contractIDToCID(storeContract).toString(),
      storeCID.toString()
    );
    const freshService = Cc[mailboxWitnessContract].createInstance(
      Ci.nsIMsgMessageService
    );
    const freshStore = Cc[storeContract].createInstance(
      Ci.nsIMsgPluggableStore
    );
    Assert.ok(freshService instanceof Ci.nsIMsgMessageService);
    Assert.equal(freshStore.storeType, lane.store);
    Assert.ok(
      witnessStoreInstances > 0,
      "The fixture used the intercepted factory"
    );
    currentWitness = null;
    // Fixture servers retain cached wrappers until this isolated process exits.
  });
  witnessRegistrations.push(
    MockRegistrar.register(mailboxWitnessContract, () =>
      observeMailboxService(nativeService)
    )
  );
  witnessRegistrations.push(
    MockRegistrar.register(storeContract, () => {
      const native = Components.classesByID[storeCID].createInstance(
        Ci.nsIMsgPluggableStore
      );
      witnessStoreInstances++;
      return observeMailboxStore(native);
    })
  );
  // nsMsgIncomingServer caches its store; both remaps must precede this call.
  witnessFixture = PanoramaDelivery.createLocalFixture("publication-witness");
});

/**
 * Reads and closes a complete message stream.
 *
 * @param {nsIInputStream} stream - The stream to consume.
 * @returns {string} The message bytes.
 */
function readWitnessBytes(stream) {
  try {
    let raw = "";
    while (stream.available()) {
      raw += NetUtil.readInputStreamToString(stream, stream.available());
    }
    return raw;
  } finally {
    stream.close();
  }
}

/**
 * Observes a real failed mailbox member and the queued follow-up request.
 *
 * @param {boolean} isMove - Whether the first request moves its three messages.
 * @returns {Promise<void>} Resolves after both requests and store checks.
 */
async function checkMailboxPublicationWitness(isMove) {
  const lane = PanoramaDelivery.expectedLane();
  const name = isMove ? "witness-move" : "witness-copy";
  const source = witnessFixture.rootFolder
    .createLocalSubfolder(name + "-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const secondSource = witnessFixture.rootFolder
    .createLocalSubfolder(name + "-second-source")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const destination = witnessFixture.rootFolder
    .createLocalSubfolder(name + "-destination")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  PanoramaDelivery.assertFolder(source, lane);
  PanoramaDelivery.assertFolder(secondSource, lane);
  const db = PanoramaDelivery.assertFolder(destination, lane);
  const state = {
    destinationURI: destination.URI,
    events: [],
    expectedRequests: [],
    requests: [],
    memberScope: null,
  };
  witnessStates.push(state);
  currentWitness = state;
  const subjects = ["Kept prefix", "Deferred attach fault", "Refused suffix"];
  const raws = subjects.map((subject, index) =>
    [
      "From: sender@invalid",
      "To: recipient@invalid",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <" + name + "-first-" + index + "@invalid>",
      "Subject: " + subject,
      "",
      "First request body " + index + ".",
      "",
    ].join("\r\n")
  );
  const secondRaws = ["one", "two"].map(word =>
    [
      "From: second@invalid",
      "To: destination@invalid",
      "Date: Wed, 02 Jan 2019 00:00:00 +0000",
      "Message-ID: <" + name + "-second-" + word + "@invalid>",
      "Subject: Second wire " + word,
      "",
      "Second request body " + word + ".",
      "",
    ].join("\r\n")
  );
  const messages = raws.map(raw => source.addMessage(raw));
  const secondMessages = secondRaws.map(raw => secondSource.addMessage(raw));
  const firstFlags = Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Marked;
  for (const header of messages) {
    header.flags = firstFlags;
  }
  const secondFlags = [
    Ci.nsMsgMessageFlags.Read | Ci.nsMsgMessageFlags.Replied,
    Ci.nsMsgMessageFlags.Read |
      Ci.nsMsgMessageFlags.Marked |
      Ci.nsMsgMessageFlags.Replied,
  ];
  for (const [index, header] of secondMessages.entries()) {
    header.subject = "Second stored " + ["one", "two"][index];
    header.flags = secondFlags[index];
  }
  const keys = messages.map(header => header.messageKey);
  const tokens = messages.map(header => header.storeToken);
  const secondKeys = secondMessages.map(header => header.messageKey);
  const secondTokens = secondMessages.map(header => header.storeToken);
  state.expectedRequests = [
    { id: 1, uri: source.URI, keys },
    { id: 2, uri: secondSource.URI, keys: secondKeys },
  ];
  const sourcePaths =
    lane.store == "maildir"
      ? tokens.map(token => PathUtils.join(source.filePath.path, "cur", token))
      : [source.filePath.path];
  const before = await Promise.all(sourcePaths.map(file => IOUtils.read(file)));
  Assert.deepEqual(
    messages.map(header => readWitnessBytes(source.getMsgInputStream(header))),
    raws
  );
  Assert.deepEqual(
    secondMessages.map(header =>
      readWitnessBytes(secondSource.getMsgInputStream(header))
    ),
    secondRaws
  );

  const events = [];
  const faults = [];
  const additions = [];
  const firstStatuses = [];
  const secondStatuses = [];
  const firstProgress = [];
  const secondProgress = [];
  let firstStop;
  let secondStop;
  const observer = {
    QueryInterface: ChromeUtils.generateQI(["nsIDBChangeListener"]),
    onHdrFlagsChanged() {},
    onHdrDeleted() {},
    onParentChanged() {},
    onAnnouncerGoingAway() {},
    onReadChanged() {},
    onJunkScoreChanged() {},
    onHdrPropertyChanged() {},
    onEvent() {},
    onHdrAdded(header) {
      try {
        additions.push([
          header.messageId,
          header.subject,
          header.author,
          header.recipients,
          header.flags,
          readWitnessBytes(destination.getMsgInputStream(header)),
          secondSource.msgDatabase.listAllKeys(),
        ]);
      } catch (error) {
        additions.push(["callback error", String(error)]);
      }
    },
  };
  const secondListener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      recordMailboxWitness(state, "second-start-copy");
      events.push("second-start");
    },
    onProgress(current, total) {
      secondProgress.push([
        current,
        total,
        secondSource.msgDatabase.listAllKeys(),
      ]);
    },
    onStopCopy(status) {
      recordMailboxWitness(state, "second-stop-copy", { status });
      events.push("second-stop");
      secondStatuses.push(status);
      secondStop = secondSource.msgDatabase.listAllKeys();
    },
  });
  const secondStopped = secondListener.promise.then(
    () => true,
    () => false
  );
  let started;
  let startFailed;
  const secondStarted = new Promise((resolve, reject) => {
    started = resolve;
    startFailed = reject;
  });
  const firstListener = new PromiseTestUtils.PromiseCopyListener({
    onStartCopy() {
      recordMailboxWitness(state, "first-start-copy");
      events.push("first-start");
    },
    onProgress(current, total) {
      firstProgress.push([current, total]);
    },
    onStopCopy(status) {
      recordMailboxWitness(state, "first-stop-copy", { status });
      events.push("first-stop");
      firstStatuses.push(status);
      if (firstStatuses.length != 1) {
        return;
      }
      try {
        firstStop = {
          sourceKeys: source.msgDatabase.listAllKeys(),
          secondKeys: secondSource.msgDatabase.listAllKeys(),
          destinationIds: Array.from(
            destination.messages,
            header => header.messageId
          ),
          sourceBodies: messages.map(header =>
            readWitnessBytes(source.getMsgInputStream(header))
          ),
          secondBodies: secondMessages.map(header =>
            readWitnessBytes(secondSource.getMsgInputStream(header))
          ),
        };
        recordMailboxWitness(state, "second-copy-call");
        MailServices.copy.copyMessages(
          secondSource,
          secondMessages,
          destination,
          true,
          secondListener,
          null,
          false
        );
        started();
      } catch (error) {
        startFailed(error);
      }
    },
  });
  const firstStopped = firstListener.promise.then(
    () => true,
    () => false
  );
  const connection = database.connectionForTests;
  connection.createFunction("delivery_local_deferred_abort", 1, {
    onFunctionCall(args) {
      recordMailboxWitness(state, "attach-fault");
      events.push("fault");
      faults.push(args.getUTF8String(0));
      throw Components.Exception(
        "Deferred AttachHdr fault",
        Cr.NS_ERROR_FAILURE
      );
    },
  });
  let active = true;
  const cleanup = () => {
    if (active) {
      active = false;
      db.removeListener(observer);
      try {
        connection.executeSimpleSQL(
          "DROP TRIGGER IF EXISTS temp.delivery_local_deferred_abort"
        );
      } finally {
        connection.removeFunction("delivery_local_deferred_abort");
      }
    }
  };
  registerCleanupFunction(cleanup);
  db.addListener(observer);
  connection.executeSimpleSQL(
    "CREATE TEMP TRIGGER delivery_local_deferred_abort BEFORE INSERT ON main.messages " +
      "WHEN NEW.subject = 'Deferred attach fault' BEGIN SELECT " +
      "delivery_local_deferred_abort(NEW.subject); END"
  );
  let firstSucceeded;
  let secondSucceeded;
  const scan = new PromiseTestUtils.PromiseStoreScanListener();
  try {
    recordMailboxWitness(state, "first-copy-call");
    MailServices.copy.copyMessages(
      source,
      messages,
      destination,
      isMove,
      firstListener,
      null,
      false
    );
    firstSucceeded = await firstStopped;
    await secondStarted;
    secondSucceeded = await secondStopped;
    await Promise.all(state.requests.map(request => request.finished));
    destination.msgStore.asyncScan(destination, scan);
    await scan.promise;
  } finally {
    cleanup();
  }
  currentWitness = null;
  const trace = state.events;
  info(
    "MAILBOX_PUBLICATION_WITNESS " +
      JSON.stringify(
        trace.map(event => ({
          seq: event.seq,
          type: event.type,
          id: event.id,
          member: event.member,
          result: event.result,
          status: event.status,
        }))
      )
  );
  const firstStops = trace.filter(
    event => event.type == "final-stop-entry" && event.id == 1
  );
  const firstCompletions = trace.filter(
    event => event.type == "first-stop-copy"
  );
  const secondStarts = trace.filter(event => event.type == "second-start-copy");
  Assert.equal(firstStops.length, 1, "One real request1 final protocol stop");
  Assert.equal(firstCompletions.length, 1);
  Assert.equal(secondStarts.length, 1);
  const finalStop = firstStops[0];
  Assert.less(
    finalStop.seq,
    firstCompletions[0].seq,
    "Final stop entry precedes first completion"
  );
  Assert.less(
    finalStop.seq,
    secondStarts[0].seq,
    "Final stop entry precedes queued request2 start"
  );
  // nsMailboxProtocol calls CloseSocket before this stop entry. This says
  // nothing about OS-handle close success or the whole callback returning.
  const starts = trace.filter(
    event => event.type == "member-start-entry" && event.id == 1
  );
  Assert.deepEqual(
    starts.map(event => event.member),
    [2, 3],
    "Native protocol reached member3"
  );
  const thirds = trace.filter(
    event =>
      event.type == "member-start-exit" && event.id == 1 && event.member == 3
  );
  Assert.equal(thirds.length, 1);
  Assert.deepEqual(
    trace
      .filter(event => event.type == "member-start-error" && event.id == 1)
      .map(event => [event.member, event.result]),
    [[3, Cr.NS_ERROR_FAILURE]],
    "Native member3 StartMessage preserves its refusal result"
  );
  const third = starts[1];
  const opens = trace.filter(event => event.type == "destination-open-entry");
  Assert.equal(
    opens.filter(event => event.scope?.id == 1 && event.scope.member == 3)
      .length,
    0,
    "No native destination stream-open entry inside actual member3 StartMessage"
  );
  Assert.equal(
    opens.filter(event => event.seq > third.seq && event.seq < thirds[0].seq)
      .length,
    0
  );
  const faultEvents = trace.filter(event => event.type == "attach-fault");
  Assert.equal(faultEvents.length, 1);
  const fault = faultEvents[0];
  Assert.less(fault.seq, third.seq);
  Assert.less(thirds[0].seq, finalStop.seq);
  const firstOpens = opens.filter(event => event.seq < finalStop.seq);
  Assert.equal(
    firstOpens.length,
    2,
    "Exactly two real destination open entries for request1"
  );
  Assert.equal(
    opens.filter(event => event.seq > fault.seq && event.seq < finalStop.seq)
      .length,
    0,
    "No destination open from AttachHdr fault through real final-stop entry"
  );
  const finishes = trace.filter(
    event => event.type == "finish-success" && event.seq < fault.seq
  );
  Assert.equal(
    finishes.length,
    2,
    "Both real Finish calls succeeded before AttachHdr failed"
  );
  Assert.equal(finishes[0].stream, firstOpens[0].stream);
  Assert.equal(finishes[1].stream, firstOpens[1].stream);
  Assert.equal(typeof finishes[1].token, "string");
  Assert.notEqual(
    finishes[1].token,
    "",
    "Finished member2 retains its actual token, including valid zero"
  );
  Assert.equal(trace.filter(event => event.type == "finish-error").length, 0);
  Assert.equal(
    trace.filter(event => event.type == "service-copy-error").length,
    0
  );
  Assert.deepEqual(
    state.requests.map(request => request.id),
    [1, 2]
  );
  for (const event of trace.filter(item => item.type == "service-copy")) {
    Assert.equal(
      event.move,
      false,
      "The local caller passes the native mailbox copy flag unchanged"
    );
    Assert.equal(event.urlListener, null);
    Assert.equal(event.msgWindow, null);
  }
  Assert.equal(
    trace.filter(event => event.type == "final-stop-entry" && event.id == 2)
      .length,
    1
  );
  Assert.equal(
    trace.filter(event => event.type == "final-stop-exit" && event.id == 1)
      .length,
    1
  );
  Assert.equal(
    trace.filter(event => event.type == "final-stop-exit" && event.id == 2)
      .length,
    1
  );
  Assert.equal(firstSucceeded, false);
  Assert.equal(secondSucceeded, true);
  Assert.deepEqual(faults, ["Deferred attach fault"]);
  Assert.deepEqual(firstStatuses, [Cr.NS_ERROR_FAILURE]);
  Assert.deepEqual(secondStatuses, [Cr.NS_OK]);
  Assert.deepEqual(events, [
    "first-start",
    "fault",
    "first-stop",
    "second-start",
    "second-stop",
  ]);
  Assert.deepEqual(firstProgress, [
    [1, 3],
    [2, 3],
  ]);
  Assert.deepEqual(secondProgress, [
    [1, 2, secondKeys],
    [2, 2, secondKeys],
  ]);
  Assert.deepEqual(firstStop, {
    sourceKeys: keys,
    secondKeys,
    destinationIds: [name + "-first-0@invalid"],
    sourceBodies: raws,
    secondBodies: secondRaws,
  });
  Assert.deepEqual(
    secondStop,
    [],
    "Only the successful second move deletes its sources"
  );
  Assert.deepEqual(additions, [
    [
      name + "-first-0@invalid",
      "Kept prefix",
      "sender@invalid",
      "recipient@invalid",
      firstFlags,
      raws[0],
      secondKeys,
    ],
    [
      name + "-second-one@invalid",
      "Second stored one",
      "second@invalid",
      "destination@invalid",
      secondFlags[0],
      secondRaws[0],
      secondKeys,
    ],
    [
      name + "-second-two@invalid",
      "Second stored two",
      "second@invalid",
      "destination@invalid",
      secondFlags[1],
      secondRaws[1],
      secondKeys,
    ],
  ]);
  Assert.deepEqual(
    Array.from(destination.messages, header => [
      header.messageId,
      header.subject,
      header.flags,
    ]).toSorted((a, b) => a[0].localeCompare(b[0])),
    [
      [name + "-first-0@invalid", "Kept prefix", firstFlags],
      [name + "-second-one@invalid", "Second stored one", secondFlags[0]],
      [name + "-second-two@invalid", "Second stored two", secondFlags[1]],
    ]
  );
  Assert.deepEqual(
    scan.messages.toSorted(),
    [raws[0], raws[1], ...secondRaws].toSorted(),
    "The store keeps the prefix, finished unpublished member and only the second request bodies"
  );
  const failedIndex = scan.messages.indexOf(raws[1]);
  Assert.equal(
    scan.tokens[failedIndex],
    finishes[1].token,
    "The retained body has the actual Finish2 identity"
  );
  Assert.notEqual(scan.tokens[failedIndex], "");
  Assert.equal(
    readWitnessBytes(
      destination.msgStore.getMsgInputStream(
        destination,
        scan.tokens[failedIndex],
        0
      )
    ),
    raws[1]
  );
  Assert.deepEqual(source.msgDatabase.listAllKeys(), keys);
  Assert.deepEqual(
    messages.map(header => header.storeToken),
    tokens
  );
  Assert.deepEqual(
    messages.map(header => header.subject),
    subjects
  );
  Assert.deepEqual(
    messages.map(header => header.flags),
    [firstFlags, firstFlags, firstFlags]
  );
  for (const [index, file] of sourcePaths.entries()) {
    Assert.deepEqual(await IOUtils.read(file), before[index]);
  }
  Assert.deepEqual(
    messages.map(header => readWitnessBytes(source.getMsgInputStream(header))),
    raws
  );
  Assert.deepEqual(secondSource.msgDatabase.listAllKeys(), []);
  if (lane.store == "maildir") {
    Assert.deepEqual(
      await IOUtils.getChildren(
        PathUtils.join(destination.filePath.path, "tmp")
      ),
      []
    );
    Assert.equal(
      (
        await IOUtils.getChildren(
          PathUtils.join(destination.filePath.path, "cur")
        )
      ).length,
      4
    );
    for (const token of secondTokens) {
      Assert.equal(
        await IOUtils.exists(
          PathUtils.join(secondSource.filePath.path, "cur", token)
        ),
        false
      );
    }
  }
  for (const folder of [source, secondSource, destination]) {
    PanoramaDelivery.assertFolder(folder, lane);
  }
}

add_task(async function test_copyWaitsForRealMailboxStop() {
  await checkMailboxPublicationWitness(false);
});

add_task(async function test_moveWaitsForRealMailboxStop() {
  await checkMailboxPublicationWitness(true);
});
