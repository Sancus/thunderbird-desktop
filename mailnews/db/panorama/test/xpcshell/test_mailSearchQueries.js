/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailSearchService } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearchService.sys.mjs"
);
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);

let service;
let queryFolder;
let copyFolder;
/** @type {Map<string, nsIMsgDBHdr>} */
const headers = new Map();

add_setup(async function setupStoredQueryMessages() {
  do_get_profile();
  loadExistingDB();
  Assert.equal(Services.prefs.getBoolPref("mail.panorama.enabled"), true);
  Assert.equal(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIDatabaseCore
    ),
    database,
    "The native backend is registered"
  );
  const pref = "mailnews.database.global.indexer.enabled";
  const hadValue = Services.prefs.prefHasUserValue(pref);
  const previous = Services.prefs.getBoolPref(pref);
  Services.prefs.setBoolPref(pref, true);
  const account = MailServices.accounts.createLocalMailAccount();
  registerCleanupFunction(async () => {
    await service?.close();
    MailServices.accounts.removeAccount(account);
    if (hadValue) {
      Services.prefs.setBoolPref(pref, previous);
    } else {
      Services.prefs.clearUserPref(pref);
    }
  });
  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  queryFolder = root
    .createLocalSubfolder("queries")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);
  copyFolder = root
    .createLocalSubfolder("queries-copy")
    .QueryInterface(Ci.nsIMsgLocalMailFolder);

  const bodies = {
    adjacent: "cobalt meadow",
    reversed: "meadow cobalt",
    separated: "cobalt valley meadow",
    firstOnly: "cobalt",
    secondOnly: "meadow",
    accent: "Caf\u00e9 \u0100wesome",
    decomposed: "Cafe\u0301",
    czech: "Slov\u00e1cko Moravsk\u00e9 rodin\u011b",
    russian: "\u041d\u043e\u0432\u043e\u0435",
    greek: "\u03d4esterday",
    width: "\uff34\uff48\uff55\uff4e\uff44\uff45\uff52\uff42\uff49\uff52\uff44",
    katakana: "\uff7b\uff9d\uff80\uff9e\uff70\uff8a\uff9e\uff70\uff84\uff9e",
    thai: "\u0e04\u0e38\u0e13\u0e2d\u0e22\u0e32\u0e01\u0e44\u0e1b\u0e14\u0e39\u0e2b\u0e19\u0e31\u0e07",
    cjk: "\u81ea\u52d5\u552e\u8ca8\u6a5f",
    supplementary: "🪐 orbitalneedle éclipse",
    unrelated: "unrelated control",
  };
  for (const [name, body] of Object.entries(bodies)) {
    addStoredQueryMessage(name, body);
  }
  addStoredQueryMessage("crossField", "meadow", { subject: "cobalt" });
  addStoredQueryMessage("eucJp", "\xbc\xab\xc6\xb0\xd3\xb4\xb2\xdf\xb5\xa1", {
    charset: "euc-jp",
    bodyIsBytes: true,
  });
  addStoredQueryMessage("shiftJis", "\x8e\xa9\x93\xae\x9aS\x89\xdd\x8b@", {
    charset: "shift-jis",
    bodyIsBytes: true,
  });
  addStoredQueryMessage("addresses", "ordinary body", {
    subject: "=?UTF-8?Q?R=C3=A9sum=C3=A9?=",
    extraHeaders: [
      "From: =?UTF-8?Q?=C3=81uteur?= <writer@example.invalid>",
      "To: =?UTF-8?Q?R=C3=A9cepteur?= <recipient@example.invalid>",
      "Cc: =?UTF-8?Q?Carb=C3=B3n?= <carbon@example.invalid>",
      "Bcc: =?UTF-8?Q?Cach=C3=A9?= <blind@example.invalid>",
    ],
  });
  headers.set(
    "attachment",
    queryFolder.addMessage(
      [
        "From: Sender <sender@example.invalid>",
        "To: Recipient <recipient@example.invalid>",
        "Message-ID: <query-attachment@example.invalid>",
        "Subject: Encoded attachment fixture",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="query-attachment"',
        "",
        "--query-attachment",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "ordinary attachment body",
        "--query-attachment",
        "Content-Type: application/octet-stream",
        "Content-Disposition: attachment; filename*=UTF-8''%E6%A4%9C%E6%9F%BB.txt",
        "",
        "payload",
        "--query-attachment--",
        "",
      ].join("\r\n")
    )
  );

  const copyOptions = { messageId: "equal-copy@example.invalid" };
  addStoredQueryMessage("copyA", "physicalcopyneedle", copyOptions);
  addStoredQueryMessage("copyB", "physicalcopyneedle", {
    ...copyOptions,
    folder: copyFolder,
  });
  Assert.equal(headers.get("copyA").messageId, headers.get("copyB").messageId);
  Assert.notEqual(
    headers.get("copyA").messageKey,
    headers.get("copyB").messageKey
  );
  Assert.notEqual(
    headers.get("copyA").folder.URI,
    headers.get("copyB").folder.URI
  );

  const file = do_get_profile().clone();
  file.append("mail-query-syntax.sqlite");
  service = await MailSearchService.open(file, database.sourceId, messageDB);
  let progress;
  for (let count = 0; count < 100; count++) {
    progress = await service.update({ limit: 500 });
    if (!progress.moreWork) {
      break;
    }
  }
  Assert.equal(
    progress.moreWork,
    false,
    "Stored MIME fixtures finished indexing"
  );
});

/**
 * Stores a message with literal header and body bytes in its physical folder.
 *
 * @param {string} name - Independent fixture name.
 * @param {string} body - Unicode body, or bytes when bodyIsBytes is true.
 * @param {object} [options] - MIME fixture fields.
 * @param {string} [options.subject] - Raw subject, defaulting to the fixture name.
 * @param {string} [options.charset="utf-8"] - Declared body encoding.
 * @param {boolean} [options.bodyIsBytes=false] - Whether the body is already encoded.
 * @param {string[]} [options.extraHeaders=[]] - Literal address headers.
 * @param {string} [options.messageId] - Raw Message-ID, defaulting to the name.
 * @param {nsIMsgLocalMailFolder} [options.folder=queryFolder] - Destination folder.
 * @returns {nsIMsgDBHdr} The independently stored physical header.
 */
function addStoredQueryMessage(
  name,
  body,
  {
    subject = "Fixture " + name,
    charset = "utf-8",
    bodyIsBytes = false,
    extraHeaders = [],
    messageId = name + "@query.example.invalid",
    folder = queryFolder,
  } = {}
) {
  const addresses = extraHeaders.length
    ? extraHeaders
    : [
        "From: Sender <sender@example.invalid>",
        "To: Recipient <recipient@example.invalid>",
      ];
  const rawHeaders = [
    ...addresses,
    "Date: Tue, 01 Jan 2019 00:00:00 +0000",
    "Message-ID: <" + messageId + ">",
    "Subject: " + subject,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=" + charset,
    "Content-Transfer-Encoding: 8bit",
    "",
    "",
  ].join("\r\n");
  const header = folder.addMessage(
    MailStringUtils.stringToByteString(rawHeaders) +
      (bodyIsBytes ? body : MailStringUtils.stringToByteString(body)) +
      "\r\n"
  );
  headers.set(name, header);
  return header;
}

/**
 * Compares public service results with independently stored physical headers.
 *
 * @param {string} text - Literal search-bar query.
 * @param {string[]} expected - Fixture names that must match.
 * @param {boolean} [andTerms=true] - Require all terms, or any term when false.
 * @returns {Promise<void>} Resolves after exact physical membership checks.
 */
async function assertQuery(text, expected, andTerms = true) {
  const page = await service.search(text, { andTerms });
  const location = header =>
    JSON.stringify([header.folder.id, header.messageKey]);
  const actual = page.items.map(hit => {
    Assert.equal(hit.id, String(hit.location.messageKey));
    return JSON.stringify([hit.location.folderId, hit.location.messageKey]);
  });
  Assert.deepEqual(
    actual.toSorted(),
    expected.map(name => location(headers.get(name))).toSorted(),
    "Exact physical query results for " + JSON.stringify({ text, andTerms })
  );
}

add_task(async function test_phraseBooleanAndProximityMembership() {
  const both = ["adjacent", "reversed", "separated", "crossField"];
  await assertQuery("cobalt meadow", both);
  await assertQuery('"cobalt meadow"', ["adjacent"]);
  await assertQuery('"meadow cobalt"', ["reversed"]);
  await assertQuery("cobalt NEAR/1 meadow", [
    "adjacent",
    "reversed",
    "separated",
  ]);
  await assertQuery(
    "cobalt meadow",
    [...both, "firstOnly", "secondOnly"],
    false
  );
  await assertQuery("aa cobalt", [...both, "firstOnly"]);
});

add_task(async function test_quoteWhitespaceAndLiteralOperatorMembership() {
  const both = ["adjacent", "reversed", "separated", "crossField"];
  await assertQuery('"cobalt meadow', both);
  await assertQuery('"" cobalt meadow', both);
  await assertQuery("cobalt\tmeadow", ["adjacent"]);
  await assertQuery("cobalt\u00a0meadow", ["adjacent"]);
  await assertQuery("cobalt:meadow", ["adjacent"]);
  await assertQuery('cobalt"meadow', ["adjacent"]);
  await assertQuery("cobalt OR meadow", both);
  await assertQuery("cobalt NOT meadow", []);
  await assertQuery("cobalt NEAR/no meadow", []);
});

add_task(async function test_emptyAndShortQueriesDoNotMatchEverything() {
  for (const text of ["", " \t\u00a0 ", "a", "aa", "a aa", '""', '"']) {
    await assertQuery(text, []);
  }
  await assertQuery("physicalcopyneedle", ["copyA", "copyB"]);
});

add_task(async function test_accentCaseWidthAndCombiningMarks() {
  // mozporter folds precomposed accents but keeps standalone combining marks.
  await assertQuery("cafe", ["accent"]);
  await assertQuery("Café", ["accent"]);
  await assertQuery("Cafe\u0301", ["decomposed"]);
  await assertQuery("awesome", ["accent"]);
  await assertQuery("rODIN\u011b", ["czech"]);
  await assertQuery("slovácko", ["czech"]);
  await assertQuery("новое", ["russian"]);
  for (const query of [
    "\u03d4esterday",
    "\u03d3esterday",
    "\u03d2esterday",
    "\u03a5esterday",
    "\u03c5esterday",
  ]) {
    await assertQuery(query, ["greek"]);
  }
  await assertQuery("Thunderbird", ["width"]);
  await assertQuery("サンダーバード", ["katakana"]);
  await assertQuery("หนัง", ["thai"]);
  await assertQuery("orbitalneedle", ["supplementary"]);
  await assertQuery("eclipse", ["supplementary"]);
});

add_task(async function test_cjkAndDeclaredLegacyBodyEncodings() {
  const encoded = ["cjk", "eucJp", "shiftJis"];
  for (const query of ["自", "自動", "售貨", "自動售貨機"]) {
    await assertQuery(query, encoded);
  }
  await assertQuery("自動售貨機機", []);
  await assertQuery("自動售貨机", []);
});

add_task(async function test_decodedHeaderFieldsRemainSearchable() {
  Assert.equal(headers.get("addresses").mime2DecodedSubject, "Résumé");
  for (const text of ["resume", "auteur", "recepteur", "carbon", "cache"]) {
    await assertQuery(text, ["addresses"]);
  }
});

add_task(async function test_decodedAttachmentFilenameRemainsSearchable() {
  await assertQuery("検査", ["attachment"]);
  await assertQuery("検", ["attachment"]);
});

add_task(async function test_cancelledQueryPreservesReasonAndNextMembership() {
  const controller = new AbortController();
  const reason = new Error("Cancelled mail syntax query");
  controller.abort(reason);
  await Assert.rejects(
    service.search("physicalcopyneedle", { signal: controller.signal }),
    error => error === reason
  );
  await assertQuery("physicalcopyneedle", ["copyA", "copyB"]);
});
