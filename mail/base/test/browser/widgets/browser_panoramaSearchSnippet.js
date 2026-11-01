/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { MailServices: snippetMailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);
const { getMailSearchService, closeMailSearch } = ChromeUtils.importESModule(
  "resource:///modules/panorama/MailSearch.sys.mjs"
);
const tabmail = document.getElementById("tabmail");
let service, win, doc, account;
const folders = [];

add_setup(async function setupNativeSnippet() {
  registerCleanupFunction(async () => {
    tabmail.closeOtherTabs(tabmail.tabInfo[0]);
    await closeMailSearch();
    for (const folder of folders) {
      folder.parent.propagateDelete(folder, true);
    }
    if (account) {
      snippetMailServices.accounts.removeAccount(account, false);
    }
  });
  account = snippetMailServices.accounts.createLocalMailAccount();
  Assert.ok(
    Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
      Ci.nsIMsgDBService
    ) instanceof Ci.nsIDatabaseCore,
    "The fixture uses the registered native backend"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["mailnews.database.global.indexer.enabled", true]],
  });

  const root = account.incomingServer.rootFolder.QueryInterface(
    Ci.nsIMsgLocalMailFolder
  );
  for (const name of ["NativeSnippetFirst", "NativeSnippetSelected"]) {
    folders.push(
      root.createLocalSubfolder(name).QueryInterface(Ci.nsIMsgLocalMailFolder)
    );
  }
  service = await getMailSearchService();
  const tab = tabmail.openTab("contentTab", {
    url: "chrome://mochitests/content/browser/comm/mail/base/test/browser/widgets/files/glodaFacetResultMessage.xhtml",
  });
  await BrowserTestUtils.browserLoaded(tab.browser);
  win = tab.browser.contentWindow;
  doc = win.document;
  await win.customElements.whenDefined("facet-result-message");
});

add_task(async function test_nativeMimeResultRendersUnicodeSnippet() {
  const headers = folders.map((folder, index) => {
    const body = index
      ? "zero\r\none\r\ntwo\r\né 😀 café 自動 end\r\nfive\r\nsix\r\nseven\r\neight"
      : "first physical copy café";
    const raw = [
      "From: Native Author <native@example.invalid>",
      "To: Recipient <recipient@example.invalid>",
      "Date: Tue, 01 Jan 2019 00:00:00 +0000",
      "Message-ID: <native-snippet-shared@example.invalid>",
      "Subject: nativesnippetneedle",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
    ].join("\r\n");
    return folder.addMessage(MailStringUtils.stringToByteString(raw));
  });
  Assert.equal(headers[0].messageId, headers[1].messageId);
  Assert.notEqual(headers[0].messageKey, headers[1].messageKey);
  for (let i = 0; ; i++) {
    Assert.less(i, 100, "The small native fixture finishes bounded indexing");
    if (!(await service.update({ limit: 50 })).moreWork) {
      break;
    }
  }
  const resultSet = await service.collectResults("nativesnippetneedle cafe");
  Assert.deepEqual(
    resultSet.items.map(item => item.id).sort(),
    headers.map(header => String(header.messageKey)).sort(),
    "Equal Message-IDs retain both indexed physical copies"
  );
  const selected = resultSet.items.find(
    item => item.id == String(headers[1].messageKey)
  );
  Assert.ok(selected, "The selected physical copy has its own projection");
  Assert.deepEqual(selected.location, {
    folderId: folders[1].id,
    messageKey: headers[1].messageKey,
  });
  const text = await service.getText(selected.id);
  Assert.equal(text.textRevision, selected.textRevision);
  const expected = "…\none\ntwo\né 😀 café 自動 end\nfive\nsix…";
  Assert.deepEqual(selected.snippet, {
    text: expected,
    ranges: [{ start: 15, end: 19 }],
    firstMatchText: "café",
  });
  win.FacetContext = {
    collection: {},
    mailSearchResultSet: resultSet,
    hoverFacet() {},
    unhoverFacet() {},
  };
  const element = doc.createElement("facet-result-message");
  element.message = selected;
  try {
    doc.body.appendChild(element);
    const body = element.querySelector(".message-body");
    Assert.equal(body.textContent, expected);
    Assert.deepEqual(
      [...body.querySelectorAll(".message-body-fulltext-match")].map(
        node => node.textContent
      ),
      ["café"],
      "Real MIME/FTS UTF-8 offsets become the selected card's UTF-16 ranges"
    );
    Assert.equal(element.firstMatchText, "café");
    Assert.equal(
      element.querySelector(".message-author").textContent,
      "Native Author"
    );
  } finally {
    element.remove();
  }
});

add_task(async function test_nativeSnippetRefreshUsesCurrentRevision() {
  const literalBody = "é 😀 café 自動 end";
  const headers = folders.map(folder =>
    folder.addMessage(
      MailStringUtils.stringToByteString(
        [
          "From: Native Author <native@example.invalid>",
          "To: Recipient <recipient@example.invalid>",
          "Date: Tue, 01 Jan 2019 00:00:00 +0000",
          "Message-ID: <snippet-revision116@example.invalid>",
          "Subject: snippetoldsubject116",
          "Content-Type: text/plain; charset=utf-8",
          "",
          literalBody,
          "",
        ].join("\r\n")
      )
    )
  );
  Assert.equal(headers[0].messageId, headers[1].messageId);
  Assert.notEqual(headers[0].messageKey, headers[1].messageKey);
  for (let i = 0; ; i++) {
    Assert.less(i, 100, "The initial native projections finish bounded indexing");
    if (!(await service.update({ limit: 50 })).moreWork) {
      break;
    }
  }
  const before = await service.collectResults("snippetoldsubject116 cafe");
  Assert.deepEqual(
    before.items.map(item => item.id).sort(),
    headers.map(header => String(header.messageKey)).sort()
  );
  const selected = before.items.find(
    item => item.id == String(headers[1].messageKey)
  );
  const control = before.items.find(
    item => item.id == String(headers[0].messageKey)
  );
  Assert.ok(selected, "The selected physical copy has an initial result");
  Assert.ok(control, "The unrelated physical copy has its own result");
  win.FacetContext = {
    collection: {},
    mailSearchResultSet: before,
    hoverFacet() {},
    unhoverFacet() {},
  };
  const originalCard = doc.createElement("facet-result-message");
  originalCard.message = selected;
  registerCleanupFunction(() => originalCard.remove());
  doc.body.appendChild(originalCard);
  const originalBody = originalCard.querySelector(".message-body");
  Assert.ok(originalBody, "The initial card has a real body snippet");
  Assert.equal(originalBody.textContent, literalBody);
  Assert.deepEqual(
    [...originalBody.querySelectorAll(".message-body-fulltext-match")].map(
      node => node.textContent
    ),
    ["café"]
  );
  Assert.equal(originalCard.firstMatchText, "café");

  headers[1].subject = "snippetcurrentsubject116";
  for (let i = 0; ; i++) {
    Assert.less(i, 100, "The real header revision finishes bounded indexing");
    if (!(await service.update({ limit: 50 })).moreWork) {
      break;
    }
  }
  const after = await service.collectResults("snippetcurrentsubject116 自動");
  Assert.deepEqual(
    after.items.map(item => item.id),
    [String(headers[1].messageKey)],
    "The refreshed query retains the exact selected physical copy"
  );
  const current = after.items[0];
  Assert.equal(current.id, selected.id);
  Assert.deepEqual(current.location, {
    folderId: folders[1].id,
    messageKey: headers[1].messageKey,
  });
  Assert.notEqual(current.textRevision, selected.textRevision);
  const text = await service.getText(current.id);
  Assert.equal(text.textRevision, current.textRevision);
  Assert.equal(text.body, literalBody);
  Assert.deepEqual(current.snippet, {
    text: literalBody,
    ranges: [{ start: 10, end: 12 }],
    firstMatchText: "自動",
  });

  win.FacetContext.mailSearchResultSet = after;
  const currentCard = doc.createElement("facet-result-message");
  currentCard.message = current;
  registerCleanupFunction(() => currentCard.remove());
  originalCard.replaceWith(currentCard);
  Assert.ok(!originalCard.isConnected, "The old result card is replaced");
  const currentBody = currentCard.querySelector(".message-body");
  Assert.ok(currentBody, "The refreshed card has the current native snippet");
  Assert.equal(currentBody.textContent, literalBody);
  Assert.deepEqual(
    [...currentBody.querySelectorAll(".message-body-fulltext-match")].map(
      node => node.textContent
    ),
    ["自動"],
    "The displayed card uses fresh UTF-16 ranges instead of the old café match"
  );
  Assert.equal(currentCard.firstMatchText, "自動");
  Assert.equal(selected.snippet.firstMatchText, "café");
  const unchanged = await service.collectResults("snippetoldsubject116 cafe");
  Assert.deepEqual(
    unchanged.items.map(item => item.id),
    [String(headers[0].messageKey)]
  );
  Assert.equal(unchanged.items[0].textRevision, control.textRevision);
  currentCard.remove();
});
