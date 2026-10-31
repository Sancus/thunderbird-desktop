/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PanoramaSearchIndex } = ChromeUtils.importESModule(
  "resource:///modules/panorama/PanoramaSearchIndex.sys.mjs"
);
const {
  loadMailSearchDocument,
  readMailSearchMime,
  getMailSearchAttachmentInfos,
} = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchContent.sys.mjs"
);
const { processSearchIndexBatch } = ChromeUtils.importESModule(
  "resource:///modules/panorama/SearchIndexer.sys.mjs"
);
const { getMailBodyText, mimeMsgToContentSnippetAndMeta } =
  ChromeUtils.importESModule(
    "resource:///modules/panorama/MessageContent.sys.mjs"
  );

add_task(function test_unquotedContentAndInputPreservation() {
  const lines = [
    "First authored line.",
    "",
    "Someone wrote:",
    "> quotedneedle",
    ">> nestedneedle",
    "",
    "Second authored line.",
    "",
  ];
  const original = lines.slice();
  Assert.equal(
    getMailBodyText(lines),
    "First authored line.\nSecond authored line."
  );
  Assert.deepEqual(lines, original);
  Assert.equal(getMailBodyText(["> quoted only"]), "");
  Assert.equal(getMailBodyText(["", ""]), "");
});

add_task(async function test_localMimeToSearchIndex() {
  do_get_profile();
  loadExistingDB();
  const pref = "mailnews.database.global.indexer.enabled";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref, false);
  Services.prefs.setBoolPref(pref, true);
  registerCleanupFunction(() => {
    if (hadPref) {
      Services.prefs.setBoolPref(pref, oldPref);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  });

  const addressBook = MailServices.ab.getDirectory("jsaddrbook://abook.sqlite");
  for (const [email, displayName] of [
    ["sender@example.invalid", "SenderCatalog"],
    ["carbon@example.invalid", "CarbonCatalog"],
    ["blind@example.invalid", "BlindCatalog"],
  ]) {
    const card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
      Ci.nsIAbCard
    );
    card.primaryEmail = email;
    card.displayName = displayName;
    const added = addressBook.addCard(card);
    registerCleanupFunction(() => addressBook.deleteCards([added]));
  }

  const account = MailServices.accounts.createLocalMailAccount();
  const folder = account.incomingServer.rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("search-content")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const header = folder.addMessage(
    [
      "From: Sender <sender@example.invalid>",
      "To: Recipient <recipient@example.invalid>",
      "Cc: Carbon Header <carbon@example.invalid>",
      "Bcc: Blind Header <blind@example.invalid>",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <content@example.invalid>",
      "Subject: =?UTF-8?Q?Par=C3=ADs_subjectneedle?=",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=search-boundary",
      "",
      "--search-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "authoredneedle",
      "",
      "Someone wrote:",
      "> quotedneedle",
      "",
      "--search-boundary",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename=reportneedle.txt",
      "Content-Transfer-Encoding: base64",
      "",
      "YWJj",
      "--search-boundary--",
      "",
    ].join("\r\n")
  );
  const state = {
    eligible: true,
    generation: 1,
    policyRevision: 0,
    contentRevision: "content-1",
    location: { folderId: folder.id, messageKey: header.messageKey },
    folder,
    canOpen: true,
    originalContentAvailable: true,
  };
  const file = do_get_profile().clone();
  file.append("search-content.sqlite");
  const index = await PanoramaSearchIndex.open(file, id =>
    id == "physical-content" ? state : null
  );
  registerCleanupFunction(() => index.close());
  await index.applyChanges({
    sourceId: "mail-fixture",
    from: 0,
    through: 1,
    changes: [
      {
        id: "physical-content",
        sequence: 1,
        generation: 1,
        policyRevision: 0,
        kind: "index",
      },
    ],
  });
  await processSearchIndexBatch(index, loadMailSearchDocument);
  Assert.equal(
    (await index.getText("physical-content")).attachmentPresence,
    true
  );
  Assert.deepEqual(
    (await index.getText("physical-content")).attachmentTypes,
    {
      types: ["application/octet-stream"],
      complete: true,
    },
    "MIME type comes from the parser, not the .txt filename"
  );
  const details = (await index.getText("physical-content")).attachmentInfos;
  Assert.equal(details.complete, true);
  Assert.equal(details.items.length, 1);
  Assert.equal(details.items[0].name, "reportneedle.txt");
  Assert.equal(details.items[0].part, "1.2");
  Assert.equal(details.items[0].externalUrl, null);
  Assert.equal((await index.getProgress()).pending, 0);
  for (const term of [
    "authoredneedle",
    "subjectneedle",
    "paris",
    "reportneedle",
    "SenderCatalog",
    "CarbonCatalog",
    "BlindCatalog",
  ]) {
    Assert.deepEqual(
      (await index.search(term)).items.map(hit => hit.id),
      ["physical-content"],
      term
    );
  }
  Assert.deepEqual((await index.search("quotedneedle")).items, []);
  Assert.deepEqual(
    (await index.search("undefined")).items,
    [],
    "Absent cards add no text"
  );

  state.eligible = false;
  let loads = 0;
  await index.applyChanges({
    sourceId: "mail-fixture",
    from: 1,
    through: 2,
    changes: [
      {
        id: "physical-content",
        sequence: 2,
        generation: 1,
        policyRevision: 0,
        kind: "index",
      },
    ],
  });
  await processSearchIndexBatch(index, () => {
    loads++;
  });
  Assert.equal(loads, 0, "Ineligible work never reads MIME");
  Assert.deepEqual((await index.search("authoredneedle")).items, []);
});

add_task(async function test_attachmentPresenceUsesParsedMime() {
  const folder = MailServices.accounts.localFoldersServer.rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("attachment-presence-plain")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const header = folder.addMessage(
    "From: sender@example.invalid\r\nSubject: presenceplain\r\n" +
      "Content-Type: text/plain\r\n\r\nplain body\r\n"
  );
  const state = {
    eligible: true,
    generation: 1,
    policyRevision: 0,
    contentRevision: "presence-1",
    originalContentAvailable: true,
    folder,
    location: { folderId: folder.id, messageKey: header.messageKey },
  };
  const document = await loadMailSearchDocument(
    { id: "attachment-mime", generation: 1, policyRevision: 0, sequence: 1 },
    state
  );
  Assert.equal(document.attachmentPresence, false, "Plain MIME proves absence");
  Assert.deepEqual(document.attachmentTypes, { types: [], complete: true });
  const file = do_get_profile().clone();
  file.append("search-attachment-presence.sqlite");
  const index = await PanoramaSearchIndex.open(file, () => state);
  registerCleanupFunction(() => index.close());
  Assert.ok(await index.index(document));
  Assert.equal(
    (await index.getText("attachment-mime")).attachmentPresence,
    false
  );
  state.eligible = false;
  Assert.equal(await index.getText("attachment-mime"), null);
});

add_task(async function test_forwardedAttachmentKeepsItsOwnMessageType() {
  const pref = "mail.inline_attachments";
  const hadPref = Services.prefs.prefHasUserValue(pref);
  const oldPref = Services.prefs.getBoolPref(pref, true);
  Services.prefs.setBoolPref(pref, true);
  registerCleanupFunction(() =>
    hadPref
      ? Services.prefs.setBoolPref(pref, oldPref)
      : Services.prefs.clearUserPref(pref)
  );
  const folder = MailServices.accounts.localFoldersServer.rootFolder
    .QueryInterface(Ci.nsIMsgLocalMailFolder)
    .createLocalSubfolder("content-forwarded-message")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  const header = folder.addMessage(
    [
      "From: sender@example.invalid",
      "To: recipient@example.invalid",
      "Message-ID: <forwarded-content@example.invalid>",
      "Subject: Forwarded attachment",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=forwarded-content",
      "",
      "--forwarded-content",
      "Content-Type: text/plain",
      "",
      "outer body",
      "--forwarded-content",
      "Content-Type: message/rfc822",
      "Content-Disposition: attachment; filename=forwarded.eml",
      "Content-Transfer-Encoding: 7bit",
      "",
      "From: enclosed@example.invalid",
      "To: recipient@example.invalid",
      "Message-ID: <enclosed-action@example.invalid>",
      "Subject: Enclosed multipart message",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=enclosed",
      "",
      "--enclosed",
      "Content-Type: text/plain",
      "",
      "forwarded body",
      "--enclosed--",
      "--forwarded-content--",
      "",
    ].join("\r\n")
  );
  const mime = await readMailSearchMime(header);
  const [part] = mime.allUserAttachments;
  Assert.equal(part.partName, "1.2");
  Assert.equal(Object.hasOwn(part, "contentType"), false);
  Assert.equal(
    part.get("content-type"),
    "multipart/mixed; boundary=enclosed",
    "Attached messages expose the enclosed headers"
  );
  const details = getMailSearchAttachmentInfos(mime);
  Assert.equal(details.complete, true);
  Assert.equal(details.items.length, 1);
  Assert.equal(details.items[0].contentType, "message/rfc822");
  Assert.equal(details.items[0].name, "forwarded.eml");
  Assert.equal(details.items[0].part, "1.2");
});

add_task(
  async function test_streamedSummaryContentKeepsLiteralMimeBoundaries() {
    const { MailStringUtils } = ChromeUtils.importESModule(
      "resource:///modules/MailStringUtils.sys.mjs"
    );
    const folder = MailServices.accounts.localFoldersServer.rootFolder
      .QueryInterface(Ci.nsIMsgLocalMailFolder)
      .createLocalSubfolder("native-summary-content099")
      .QueryInterface(Ci.nsIMsgLocalMailFolder);
    registerCleanupFunction(() => folder.parent.propagateDelete(folder, true));
    const cases = [
      {
        name: "plain-signature",
        type: "text/plain; charset=utf-8",
        body: "Authored café\r\n\r\nPat wrote:\r\n> quotedneedle\r\n\r\n-- \r\nSignature Ω\r\n",
        expected: "Authored café\n-- \nSignature Ω",
      },
      {
        name: "html",
        type: "text/html; charset=utf-8",
        body: "<html><body><p>HTML authored &amp; final</p></body></html>",
        expected: "HTML authored & final",
      },
      {
        name: "alternative",
        type: 'multipart/alternative; boundary="summary-alternative099"',
        body: [
          "--summary-alternative099",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Preferred plain",
          "-- ",
          "Plain signature",
          "--summary-alternative099",
          "Content-Type: text/html; charset=utf-8",
          "",
          "<p>Nonpreferred HTML alternative</p>",
          "--summary-alternative099--",
          "",
        ].join("\r\n"),
        expected: "Preferred plain\n-- \nPlain signature",
      },
      {
        name: "empty",
        type: "text/plain; charset=utf-8",
        body: "",
        expected: "",
      },
      {
        name: "encrypted",
        fixture:
          "unsigned-encrypted-to-0xf231550c4f47e38e-from-0xfbfcc82a015e7330.eml",
        subject: "...",
        expected: "",
      },
    ];
    for (const item of cases) {
      const subject = item.subject ?? "summary099-" + item.name;
      const raw = item.fixture
        ? await IOUtils.readUTF8(do_get_file(item.fixture).path)
        : [
            "From: sender@example.invalid",
            "To: recipient@example.invalid",
            "Message-ID: <native-" + subject + "@example.invalid>",
            "Subject: " + subject,
            "MIME-Version: 1.0",
            "Content-Type: " + item.type,
            "",
            item.body,
            "",
          ].join("\r\n");
      const header = folder.addMessage(MailStringUtils.stringToByteString(raw));
      const mime = await readMailSearchMime(header);
      if (item.name == "encrypted") {
        Assert.ok(
          mime
            .get("content-type")
            .toLowerCase()
            .startsWith("multipart/encrypted"),
          "The actual stored fixture is an encrypted OpenPGP MIME message"
        );
        Assert.equal(
          mime.coerceBodyToPlaintext(folder),
          "",
          "The encrypted fixture supplies no plaintext summary body"
        );
      }
      Assert.deepEqual(
        mimeMsgToContentSnippetAndMeta(mime, folder, 300),
        [item.expected, { subject }],
        item.name + " keeps the literal summary and subject"
      );
      if (item.name == "plain-signature") {
        Assert.deepEqual(mimeMsgToContentSnippetAndMeta(mime, folder, 10), [
          "Authored …",
          { subject },
        ]);
      }
    }
  }
);
