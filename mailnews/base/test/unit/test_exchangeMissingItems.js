/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { EwsServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/EwsServer.sys.mjs"
);
const { GraphServer } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/GraphServer.sys.mjs"
);
const { MessageGenerator } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/MessageGenerator.sys.mjs"
);

const { ServerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/ServerTestUtils.sys.mjs"
);

const MESSAGES_NS =
  "http://schemas.microsoft.com/exchange/services/2006/messages";
const TYPES_NS = "http://schemas.microsoft.com/exchange/services/2006/types";

add_setup(function () {
  do_get_profile();
});

add_task(async function test_ewsReportsEachMissingItem() {
  const server = new EwsServer();
  const message = new MessageGenerator().makeMessage({
    subject: "Present item",
    from: ["Sender", "sender@example.invalid"],
    to: [["Recipient", "recipient@example.invalid"]],
    body: { body: "Fixture body.\r\n" },
  });
  const raw = message.toMessageString();
  server.addItemToFolder("present", "inbox", message);
  server.addItemToFolder("no-mime", "inbox", null);
  server.start();
  try {
    const response = await fetch(
      "http://127.0.0.1:" + server.port + "/EWS/Exchange.asmx",
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa("user:password"),
          "Content-Type": "text/xml",
        },
        body:
          '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
          'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">' +
          '<s:Body><GetItem xmlns="http://schemas.microsoft.com/exchange/services/2006/messages">' +
          "<ItemShape><t:BaseShape>IdOnly</t:BaseShape>" +
          "<t:IncludeMimeContent>true</t:IncludeMimeContent></ItemShape>" +
          '<ItemIds><t:ItemId Id="missing-before"/><t:ItemId Id="present"/>' +
          '<t:ItemId Id="no-mime"/><t:ItemId Id="missing-after"/></ItemIds>' +
          "</GetItem></s:Body></s:Envelope>",
      }
    );
    Assert.equal(response.status, 200);
    const document = new DOMParser().parseFromString(
      await response.text(),
      "text/xml"
    );
    const results = [
      ...document.getElementsByTagNameNS(MESSAGES_NS, "GetItemResponseMessage"),
    ];
    Assert.equal(results.length, 4);
    Assert.deepEqual(
      results.map(result => result.getAttribute("ResponseClass")),
      ["Error", "Success", "Success", "Error"]
    );
    Assert.deepEqual(
      results.map(
        result =>
          result.getElementsByTagNameNS(MESSAGES_NS, "ResponseCode")[0]
            .textContent
      ),
      ["ErrorItemNotFound", "NoError", "NoError", "ErrorItemNotFound"]
    );
    for (const index of [0, 3]) {
      const messageText = results[index].getElementsByTagNameNS(
        MESSAGES_NS,
        "MessageText"
      );
      Assert.equal(messageText.length, 1);
      Assert.ok(messageText[0].textContent.trim());
      Assert.equal(
        results[index].getElementsByTagNameNS(MESSAGES_NS, "Items").length,
        0
      );
    }
    const mime = results[1].getElementsByTagNameNS(TYPES_NS, "MimeContent");
    Assert.equal(mime.length, 1);
    Assert.equal(atob(mime[0].textContent), raw);
    Assert.equal(
      results[2]
        .getElementsByTagNameNS(TYPES_NS, "ItemId")[0]
        .getAttribute("Id"),
      "no-mime"
    );
    Assert.equal(
      results[2].getElementsByTagNameNS(TYPES_NS, "MimeContent").length,
      0
    );
  } finally {
    await server.stop();
  }
});

add_task(async function test_graphReturns404ForMissingItem() {
  const server = new GraphServer();
  server.start();
  try {
    const response = await fetch(
      "http://127.0.0.1:" + server.port + "/v1.0/me/messages/missing/$value"
    );
    Assert.equal(response.status, 404);
    Assert.equal(await response.text(), "");
  } finally {
    await server.stop();
  }
});

add_task(async function test_graphReturns404ForMissingMime() {
  const server = new GraphServer();
  server.addItemToFolder("no-mime", "inbox", null);
  server.start();
  try {
    const response = await fetch(
      "http://127.0.0.1:" + server.port + "/v1.0/me/messages/no-mime/$value"
    );
    Assert.equal(response.status, 404);
    Assert.equal(await response.text(), "");
  } finally {
    await server.stop();
  }
});

add_task(async function test_graphReturnsExistingMime() {
  const server = new GraphServer();
  const message = new MessageGenerator().makeMessage({ subject: "Graph item" });
  const raw = message.toMessageString();
  server.addItemToFolder("present", "inbox", message);
  server.start();
  try {
    const response = await fetch(
      "http://127.0.0.1:" + server.port + "/v1.0/me/messages/present/$value"
    );
    Assert.equal(response.status, 200);
    Assert.equal(await response.text(), raw);
  } finally {
    await server.stop();
  }
});

add_task(async function test_ewsUpdateItemPreservesMixedOutcomes() {
  const server = new EwsServer();
  const generator = new MessageGenerator();
  for (const [id, flagged, read] of [
    ["flag-present", false, false],
    ["unflag-present", true, true],
    ["unselected", true, false],
  ]) {
    const message = generator.makeMessage({ subject: id });
    message.metaState.flagged = flagged;
    message.metaState.read = read;
    server.addItemToFolder(id, "inbox", message);
  }
  const changes = [
    ["missing-before", true],
    ["flag-present", true],
    ["missing-middle", false],
    ["unflag-present", false],
    ["missing-after", true],
  ];
  const itemChanges = changes
    .map(
      ([id, flagged]) => `
    <t:ItemChange>
      <t:ItemId Id="${id}"/>
      <t:Updates>
        <t:SetItemField>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:Message><t:IsRead>${flagged}</t:IsRead></t:Message>
        </t:SetItemField>
        <t:SetItemField>
          <t:FieldURI FieldURI="item:Flag"/>
          <t:Message><t:Flag><FlagStatus xmlns="${TYPES_NS}">${
            flagged ? "Flagged" : "NotFlagged"
          }</FlagStatus></t:Flag></t:Message>
        </t:SetItemField>
        <t:SetItemField>
          <t:ExtendedFieldURI PropertyTag="4240" PropertyType="Integer"/>
          <t:Message><t:ExtendedProperty>
            <t:ExtendedFieldURI PropertyTag="4240" PropertyType="Integer"/>
            <t:Value>${flagged ? 2 : 0}</t:Value>
          </t:ExtendedProperty></t:Message>
        </t:SetItemField>
      </t:Updates>
    </t:ItemChange>`
    )
    .join("");
  server.start();
  try {
    const response = await fetch(
      "http://127.0.0.1:" + server.port + "/EWS/Exchange.asmx",
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa("user:password"),
          "Content-Type": "text/xml",
        },
        body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
          xmlns:t="${TYPES_NS}"><s:Body>
          <UpdateItem xmlns="${MESSAGES_NS}" ConflictResolution="AlwaysOverwrite"
            MessageDisposition="SaveOnly"><ItemChanges>${itemChanges}</ItemChanges>
          </UpdateItem></s:Body></s:Envelope>`,
      }
    );
    Assert.equal(response.status, 200);
    const document = new DOMParser().parseFromString(
      await response.text(),
      "text/xml"
    );
    const results = [
      ...document.getElementsByTagNameNS(
        MESSAGES_NS,
        "UpdateItemResponseMessage"
      ),
    ];
    Assert.equal(results.length, 5);
    Assert.deepEqual(
      results.map(result => result.getAttribute("ResponseClass")),
      ["Error", "Success", "Error", "Success", "Error"]
    );
    Assert.deepEqual(
      results.map(
        result =>
          result.getElementsByTagNameNS(MESSAGES_NS, "ResponseCode")[0]
            .textContent
      ),
      [
        "ErrorItemNotFound",
        "NoError",
        "ErrorItemNotFound",
        "NoError",
        "ErrorItemNotFound",
      ]
    );
    for (const index of [0, 2, 4]) {
      const messageText = results[index].getElementsByTagNameNS(
        MESSAGES_NS,
        "MessageText"
      );
      Assert.equal(messageText.length, 1);
      Assert.ok(messageText[0].textContent.trim());
      Assert.equal(
        results[index].getElementsByTagNameNS(MESSAGES_NS, "Items").length,
        0
      );
      Assert.strictEqual(server.getItemInfo(changes[index][0]), null);
    }
    for (const [index, id] of [
      [1, "flag-present"],
      [3, "unflag-present"],
    ]) {
      const itemId = results[index].getElementsByTagNameNS(
        TYPES_NS,
        "ItemId"
      )[0];
      Assert.equal(itemId.getAttribute("Id"), id);
      Assert.equal(itemId.getAttribute("ChangeKey"), "abc12345");
      Assert.equal(
        results[index].getElementsByTagNameNS(TYPES_NS, "Count")[0].textContent,
        "0"
      );
    }
    for (const [id, flagged, read] of [
      ["flag-present", true, true],
      ["unflag-present", false, false],
      ["unselected", true, false],
    ]) {
      const state = server.getItemInfo(id).syntheticMessage.metaState;
      Assert.strictEqual(state.flagged, flagged, id + " flag state");
      Assert.strictEqual(state.read, read, id + " read state");
    }
    Assert.deepEqual([...server.items()].map(([id]) => id).sort(), [
      "flag-present",
      "unflag-present",
      "unselected",
    ]);
  } finally {
    await server.stop();
  }
});

add_task(async function test_mockStopCompletionAndOriginalError() {
  for (const Server of [EwsServer, GraphServer]) {
    const server = new Server();
    server.start();
    const stopped = server.stop();
    try {
      Assert.equal(
        typeof stopped?.then,
        "function",
        "Mock shutdown returns an observable completion promise"
      );
      await stopped;
      Assert.throws(
        () => server.stop(),
        error => error.result === Cr.NS_ERROR_UNEXPECTED,
        "A second stop preserves the HTTP server's original synchronous error"
      );
    } finally {
      await stopped;
    }
  }
});

add_task(async function test_mockTlsStopCompletionAndOriginalError() {
  const tlsCert = await ServerTestUtils.getCertificate("valid");
  for (const Server of [EwsServer, GraphServer]) {
    const server = new Server({ tlsCert });
    server.start();
    const stopped = server.stop();
    try {
      Assert.equal(
        typeof stopped?.then,
        "function",
        "TLS mock shutdown returns an observable completion promise"
      );
      await stopped;
      Assert.throws(
        () => server.stop(),
        error => error.result === Cr.NS_ERROR_UNEXPECTED,
        "A second TLS stop preserves the original synchronous error"
      );
    } finally {
      await stopped;
    }
  }
});
