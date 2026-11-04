/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Tests that we can read Mork (.msf) data. */

var { MailStringUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailStringUtils.sys.mjs"
);
var { MorkParser } = ChromeUtils.importESModule(
  "resource:///modules/MorkParser.sys.mjs"
);

add_task(async function testReadMSF() {
  const path = do_get_file("../../../data/love.msf").path;
  const msfData = await IOUtils.read(path);
  const msf = MailStringUtils.uint8ArrayToByteString(msfData);
  const parsed = new MorkParser().parseContent(msf);

  Assert.ok(Array.isArray(parsed), "should get array data");

  // Get the specific table containing message headers
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];
  Assert.ok(Array.isArray(msgTable), "messages table should be an array");

  // Find the message in the table
  const msgRow = msgTable.find(row => row["@id"] === "1");
  Assert.ok(msgRow, "should find the target message row");
  Assert.equal(
    msgRow["message-id"],
    "fe06cac4-18ed-43aa-98a9-ee358e82b368@example.com"
  );
});

add_task(async function testReadMSFWithJSON() {
  const path = do_get_file("../../../data/withjson.msf").path;
  const msfData = await IOUtils.read(path);
  const msf = MailStringUtils.uint8ArrayToByteString(msfData);
  const parsed = new MorkParser().parseContent(msf);

  Assert.ok(Array.isArray(parsed), "should get array data");

  // Column states are stored in the folder info table, not the messages table

  const folderInfoTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:dbfolderinfo:all"
  );
  const folderInfoTable = folderInfoTableObj ? folderInfoTableObj.data : [];
  Assert.ok(
    Array.isArray(folderInfoTable),
    "folder info table should be an array"
  );

  // The new MorkParser automatically unpacks embedded JSON (like columnStates)
  const statesRow = folderInfoTable.find(row => row.columnStates);
  Assert.ok(statesRow, "should find the row with columnStates");
  Assert.equal(statesRow.columnStates.selectCol.visible, false);

  // Check the messages table for the specific message
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];
  Assert.ok(Array.isArray(msgTable), "messages table should be an array");

  const msgRow = msgTable.find(row => row["@id"] === "43");
  Assert.ok(msgRow, "should find the ex.sqlite message row");
  Assert.equal(msgRow["message-id"], "ex.sqlite@example");
});

add_task(async function testAngleBracketAndLinebreakBug() {
  // Construct a minimal MSF payload mimicking the bug conditions:
  // 1. A value containing an unescaped angle bracket (->)
  // 2. A dictionary pair with a hard linebreak between the hex ID (DB) and the value
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)>
<(8A=Test -> Inbox)(DB
 =Test POP3)>
{1:^80 {(k^96:c)(s=9)}
  [1(^81^8A)]
  [2(^81^DB)]
}`;

  const parsed = new MorkParser().parseContent(msfData);
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];

  Assert.ok(Array.isArray(msgTable), "messages table should exist");

  // Verify the unescaped angle bracket (> ) did not truncate the block
  const msg1 = msgTable.find(row => row["@id"] === "1");
  Assert.equal(
    msg1.subject,
    "Test -> Inbox",
    "Subjects with angle brackets should parse perfectly"
  );

  // Verify the linebreak between the ID (DB) and the value was handled
  const msg2 = msgTable.find(row => row["@id"] === "2");
  Assert.equal(
    msg2.subject,
    "Test POP3",
    "Values with linebreaks before the assignment should parse perfectly"
  );
});

add_task(async function testDoubleSlashInValueBug() {
  // Construct a minimal MSF payload mimicking the double-slash bug:
  // 1. A subject value containing a URL (https://...)
  // 2. A subject value containing arbitrary text with a double slash
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)>
<(8A=https://bugzilla.mozilla.org)(8B=Meeting // Updates)>
{1:^80 {(k^96:c)(s=9)}
  [1(^81^8A)]
  [2(^81^8B)]
}`;

  const parsed = new MorkParser().parseContent(msfData);
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];

  Assert.ok(Array.isArray(msgTable), "messages table should exist");

  // Verify that the URL with a double slash was not truncated
  const msg1 = msgTable.find(row => row["@id"] === "1");
  Assert.ok(msg1, "Row 1 should be parsed successfully");
  Assert.equal(
    msg1.subject,
    "https://bugzilla.mozilla.org",
    "URLs containing double slashes (//) should not be truncated"
  );

  // Verify that regular text with a double slash was not truncated
  const msg2 = msgTable.find(row => row["@id"] === "2");
  Assert.ok(msg2, "Row 2 should be parsed successfully");
  Assert.equal(
    msg2.subject,
    "Meeting // Updates",
    "Values containing double slashes (//) should not be truncated"
  );
});

add_task(async function testBracketInValueBug() {
  // Construct a minimal MSF payload mimicking the bracket bug:
  // 1. A value consisting entirely of bracketed text (like an IP)
  // 2. A value containing bracketed text inside a longer string
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)>
<(8A=[127.0.0.1])(8B=Received from [unix socket] by server)>
{1:^80 {(k^96:c)(s=9)}
  [1(^81^8A)]
  [2(^81^8B)]
}`;

  const parsed = new MorkParser().parseContent(msfData);
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];

  Assert.ok(Array.isArray(msgTable), "messages table should exist");

  // The most critical assertion: ensure the parser didn't spawn phantom rows
  // out of the bracketed strings in the values.
  Assert.equal(
    msgTable.length,
    2,
    "Should only parse the 2 explicit rows, safely ignoring brackets inside dictionary values"
  );

  // Verify the literal bracketed IP was successfully preserved as text
  const msg1 = msgTable.find(row => row["@id"] === "1");
  Assert.ok(msg1, "Row 1 should be parsed successfully");
  Assert.equal(
    msg1.subject,
    "[127.0.0.1]",
    "Values consisting of brackets should be parsed exactly as literal text"
  );

  // Verify the embedded brackets were preserved
  const msg2 = msgTable.find(row => row["@id"] === "2");
  Assert.ok(msg2, "Row 2 should be parsed successfully");
  Assert.equal(
    msg2.subject,
    "Received from [unix socket] by server",
    "Values containing brackets should not disrupt the parser state machine"
  );
});

add_task(async function testAdjacentTableAndRowBug() {
  // Construct a minimal MSF payload mimicking the adjacent table/row bug:
  // The old parser's regex would accidentally consume the '[' if a row
  // immediately followed a table's closing brace like `}[A:^80]`.
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)>
<(8A=Adjacent Row Test)>
{7:^80 {(k^97:c)(s=9)7:m } 7 8 9 }[A:^80(^81^8A)]`;

  const parsed = new MorkParser().parseContent(msfData);
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];

  Assert.ok(Array.isArray(msgTable), "messages table should exist");

  // Verify the row immediately following the table was parsed successfully
  const msgA = msgTable.find(row => row["@id"] === "A");

  Assert.ok(msgA, "Row A should be parsed successfully");
  Assert.equal(
    msgA.subject,
    "Adjacent Row Test",
    "Rows immediately following a table declaration (}[...]) should be parsed perfectly"
  );
});

add_task(async function testUnpackEmbeddedJsonEscapes() {
  // Simulate a stringified JSON object that was split across lines by Mork.
  // Note: We have to double-escape backslashes in the JS literal so the
  // string holds the literal characters: \n and \\
  const input = '{"path": "C:\\\\folder", \\\n"text": "line1\\nline2"}';

  // If the old, aggressive regex (/\\([^"]/g) was used, "C:\\folder" would
  // become "C:folder", and "\\n" would become "n", mangling the data.
  const result = MorkParser.unpackEmbeddedJson(input);

  Assert.equal(
    typeof result,
    "object",
    "Should successfully parse the embedded JSON"
  );

  Assert.equal(
    result.path,
    "C:\\folder",
    "Should preserve standard JSON escaped backslashes"
  );

  Assert.equal(
    result.text,
    "line1\nline2",
    "Should preserve standard JSON escaped newlines"
  );
});

add_task(async function testWhitespacePreservationInLiteralValues() {
  // Construct a minimal MSF payload with heavily padded structural whitespace
  // (newlines and indentation) to prove the parser doesn't choke, and a literal
  // row value that contains intentional spaces ("Hello World").
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)>
  
  {1:^80 {(k^96:c)(s=9)}
    
    [ 1( ^81=Hello World ) ]
    
  }`;

  const parsed = new MorkParser().parseContent(msfData);
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];

  Assert.ok(Array.isArray(msgTable), "messages table should exist");

  // Verify the row was found and the literal spaces were perfectly preserved
  const msg1 = msgTable.find(row => row["@id"] === "1");

  Assert.ok(
    msg1,
    "Row 1 should be parsed successfully despite the structural padding"
  );

  // If the old blanket regex (/\s+/g) was still active, this would equal "HelloWorld"
  Assert.equal(
    msg1.subject,
    "Hello World",
    "Literal values containing spaces should not be stripped of their whitespace"
  );
});

add_task(async function testEncodingFixes() {
  // Construct a minimal MSF payload mimicking the two encoding scenarios:
  // 1. Contiguous UTF-8 bytes that span multiple characters ("standardmäßig")
  // 2. Legacy single-byte encoding that requires the fallback ("Märchen")
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)(82=preview)>
<(8A=standardm$C3$A4$C3$9Fig)(8B=M$E4rchen)>
{1:^80 {(k^96:c)(s=9)}
  [1(^81^8A)(^82^8B)]
}`;

  const parsed = new MorkParser().parseContent(msfData);
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];

  Assert.ok(Array.isArray(msgTable), "messages table should exist");

  const msg1 = msgTable.find(row => row["@id"] === "1");
  Assert.ok(msg1, "Row 1 should be parsed successfully");

  // Verify the contiguous UTF-8 sequence was decoded perfectly
  // without dropping the last byte or creating C1 control characters.
  Assert.equal(
    msg1.subject,
    "standardmäßig",
    "Contiguous UTF-8 bytes should be decoded correctly without chunking errors"
  );

  // Verify that an invalid UTF-8 byte ($E4) correctly threw an error
  // in the strict TextDecoder and fell back to the legacy ISO-8859-1 decoding.
  Assert.equal(
    msg1.preview,
    "Märchen",
    "Legacy single-byte encodings (invalid UTF-8) should safely fall back to ISO-8859-1"
  );
});

add_task(async function testEscapedLiteralValues() {
  // Construct a minimal MSF payload mimicking escaped dollar signs:
  // 1. A mixed sequence: escaped \\$ followed by an unescaped $
  // 2. A fully escaped sequence: both $ signs have backslashes
  // Note: We use \\$ in the JS literal to represent a single literal \ in the MSF.
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)>
<(8A=Hello \\$C3$A4)(8B=\\$C3\\$A4 at the start)>
{1:^80 {(k^96:c)(s=9)}
  [1(^81^8A)]
  [2(^81^8B)]
}`;

  const parsed = new MorkParser().parseContent(msfData);
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];

  Assert.ok(Array.isArray(msgTable), "messages table should exist");

  const msg1 = msgTable.find(row => row["@id"] === "1");
  Assert.ok(msg1, "Row 1 should be parsed successfully");

  // Verify that the unescaped $A4 was correctly decoded into ¤ (ISO-8859-1),
  // while the escaped \\$C3 was preserved.
  Assert.equal(
    msg1.subject,
    "Hello \\$C3¤",
    "Unescaped sequences following escaped ones should be correctly decoded"
  );

  const msg2 = msgTable.find(row => row["@id"] === "2");
  Assert.ok(msg2, "Row 2 should be parsed successfully");

  // Verify that when both are escaped, the whole string is preserved as text.
  Assert.equal(
    msg2.subject,
    "\\$C3\\$A4 at the start",
    "Fully escaped sequences at the beginning of a string should be preserved as literal text"
  );
});

add_task(async function testSplitEmailsQuotedCommas() {
  // Create a mock raw Mork object with tricky email formatting
  // (Commas inside quotes, spaces after delimiters, etc.)
  const rawMorkRow = {
    "@id": "1:^80",
    // 1. Single sender with a comma in the quoted name
    sender: '"Picard, Jean-Luc" <captainexample.org>',
    // 2. Multiple recipients with a space after the delimiter and a comma in the quote
    recipients:
      'data@example.org, "Riker, William T." <number.one@example.org>',
    // 3. Complex list with multiple quoted names and plain emails
    ccList:
      '"Last, First" <last@example.org>, "Another, Name" <another@example.org>, plain@example.org',
  };

  const prettyData = MorkParser.readableMsgHdrData(rawMorkRow);

  // Verify Sender
  Assert.deepEqual(
    prettyData.from,
    ['"Picard, Jean-Luc" <captainexample.org>'],
    "Should not split a single sender with a comma inside quotes"
  );

  // Verify Recipients (The exact scenario the reviewer caught)
  Assert.deepEqual(
    prettyData.recipients,
    ["data@example.org", '"Riker, William T." <number.one@example.org>'],
    "Should correctly split multiple recipients while ignoring commas inside quotes"
  );

  // Verify CC List
  Assert.deepEqual(
    prettyData.ccList,
    [
      '"Last, First" <last@example.org>',
      '"Another, Name" <another@example.org>',
      "plain@example.org",
    ],
    "Should handle complex lists with multiple quoted names containing commas"
  );
});

add_task(async function testUnescapedParenthesisInRowCell() {
  // Construct a minimal MSF payload mimicking the "Received" header bug:
  // A row cell value contains an unescaped opening parenthesis '('
  // and an escaped closing parenthesis '\)'.
  // Note: We use \\) in the JS string literal to represent \) in the Mork file.
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)(82=received)>
{1:^80 {(k^96:c)(s=9)}
  [1(^81=Test Subject)(^82=from localhost ([127.0.0.1]\\) by server)]
}`;

  const parser = new MorkParser();
  const parsed = parser.parseContent(msfData);
  const msgTableObj = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  );
  const msgTable = msgTableObj ? msgTableObj.data : [];

  Assert.ok(Array.isArray(msgTable), "messages table should exist");

  const msg1 = msgTable.find(row => row["@id"] === "1");
  Assert.ok(msg1, "Row 1 should be parsed successfully");

  // Verify that the unescaped '(' did not shatter the cell and the escaped '\\)'
  // was correctly transformed back into a standard closing bracket.
  Assert.equal(
    msg1.received,
    "from localhost ([127.0.0.1]) by server",
    "Values containing unescaped opening parentheses should not be fragmented"
  );

  // Ensure that no "Malformed cell data" warnings were thrown for this row
  const malformedWarnings = parser.warnings.filter(w =>
    w.includes("Malformed cell data")
  );
  Assert.equal(
    malformedWarnings.length,
    0,
    "Should not generate malformed cell warnings for unescaped parentheses"
  );
});

add_task(async function testUnterminatedBlocks() {
  // Without caching, each unterminated block rescans to the end of the
  // content, which would make this take minutes.
  const count = 200000;
  for (const char of ["<", "{", "["]) {
    const parser = new MorkParser();
    parser.parseContent(char.repeat(count));
    Assert.equal(
      parser.warnings.length,
      count,
      `should warn once per unterminated ${char} block`
    );
  }

  const parser = new MorkParser();
  parser.parseContent(`{1:^80 ${"[".repeat(count)} }`);
  Assert.equal(parser.total, 0, "should not find rows in unterminated blocks");
});

add_task(async function testUnterminatedTableRecovery() {
  // A truncated table: the outer { is never closed, but the rows nested in
  // it should still be found.
  const msfData = `< <(a=c)>(80=ns:msg:db:row:scope:msgs:all)(81=subject)>
{1:^80 {(k^96:c)(s=9)}
  [1:^80(^81=One)]
  [2:^80(^81=Two)]
  [3:^80(^81=Three)]
`;

  const parser = new MorkParser();
  const parsed = parser.parseContent(msfData);
  const msgTable = parsed.find(
    t => t["@id"] === "ns:msg:db:row:scope:msgs:all"
  ).data;
  Assert.deepEqual(
    msgTable.map(row => row.subject),
    ["One", "Two", "Three"],
    "should recover rows from an unterminated table"
  );
});

add_task(async function test_strictSummaryAndCache() {
  const read = async path =>
    new MorkParser().parseForImport(
      MailStringUtils.uint8ArrayToByteString(await IOUtils.read(path))
    );
  const summary = await read(do_get_file("../../../data/love.msf").path);
  const scope = "ns:msg:db:row:scope:msgs:all";
  const row = summary.rows.get("1:" + scope);
  Assert.equal(
    row.cells.get("message-id"),
    "fe06cac4-18ed-43aa-98a9-ee358e82b368@example.com"
  );
  Assert.ok(row.cells.has("references"), "Present empty is retained");
  Assert.equal(row.cells.get("references"), "");
  Assert.ok(!row.cells.has("absent-property"));
  Assert.equal(
    row.cells.get("gloda-id"),
    "c1",
    "Committed group updates apply"
  );
  Assert.deepEqual(summary.tables.get("1:" + scope).rows, ["1:" + scope]);
  Assert.equal(
    summary.rows
      .get("1:ns:msg:db:row:scope:dbfolderinfo:all")
      .cells.get("sortColumns"),
    "\x122"
  );

  const cache = await read(do_get_file("data/panacea.dat").path);
  const folders = "ns:msg:db:row:scope:folders:all";
  Assert.equal(cache.tables.get("1:" + folders).rows.length, 13);
  Assert.equal(
    cache.rows.get("1:" + folders).cells.get("key"),
    "/foo/bar/profile-default/ImapMail/imap.localhost/INBOX.msf"
  );
  Assert.equal(cache.rows.get("13:" + folders).cells.get("onlineName"), "");
});

add_task(function test_strictExactCellsAndMembership() {
  const groupStart = "@$${";
  const body = String.raw`// <!-- <mdb:mork:z v="1.4"/> -->
< <(a=c)> (80=scope)(81=kind)(82=unknown)(83=empty)(84=columnStates)>
<(80=)(81=  leading and trailing  )(82=slash\\$24$00\))>
{1:^80 {(k^81:c)(s=9)} [1(^82^81)(^83^80)(^84={"x":1})] [2(^82^82)]}
START_A
[1:^80(^82=committed)]
@$$}A}@
{1:^80 {(k^81:c)(s=9)} -2}
START_B
[1:^80(^82=aborted)]
@$$}~~}@
`
    .replace("START_A", () => groupStart + "A{@")
    .replace("START_B", () => groupStart + "B{@");
  const snapshot = new MorkParser().parseForImport(body);
  Assert.deepEqual(snapshot.tables.get("1:scope").rows, ["1:scope"]);
  Assert.equal(snapshot.rows.get("1:scope").cells.get("unknown"), "committed");
  Assert.equal(snapshot.rows.get("1:scope").cells.get("empty"), "");
  Assert.equal(
    snapshot.rows.get("1:scope").cells.get("columnStates"),
    '{"x":1}'
  );
  Assert.equal(
    snapshot.rows.get("2:scope").cells.get("unknown"),
    "slash\\$\0)"
  );
  Assert.ok(
    snapshot.rows.has("2:scope"),
    "Cut membership does not delete a shared row"
  );
  const original = new MorkParser().parseForImport(
    body.slice(0, body.indexOf(groupStart))
  );
  Assert.equal(
    original.rows.get("1:scope").cells.get("unknown"),
    "  leading and trailing  "
  );
});

add_task(function test_strictFailuresDoNotRecover() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  for (const [body, code] of [
    ["[1:r(a=value)", "TRUNCATED_MORK"],
    ["@$${A{@\n[1:r(a=value)]", "TRUNCATED_MORK"],
    ["@$${A{@\n@$$}B}@", "MALFORMED_MORK"],
    ["[1:r(a^FF)]", "MALFORMED_MORK"],
    ["{1:r {(k=kind)(f=1)}}", "UNSUPPORTED_MORK"],
    ["[1:r(a=value)] trailing", "MALFORMED_MORK"],
  ]) {
    Assert.throws(
      () => new MorkParser().parseForImport(header + body),
      error => error.name == "MorkImportError" && error.code == code,
      body
    );
  }
});

add_task(function test_strictClearAndComments() {
  const snapshot = new MorkParser()
    .parseForImport(String.raw`// <!-- <mdb:mork:z v="1.4"/> -->
/* Outer comment with } ] > /* nested */ end */
{1:r {(k=kind)} [1(a=old)(b=old)] [2(a=other)]}
{-1:r {(k=kind)} [1(a=changed)]}
[-1:r(b=)]
`);
  Assert.deepEqual(snapshot.tables.get("1:r").rows, ["1:r"]);
  Assert.ok(
    !snapshot.rows.get("1:r").cells.has("a"),
    "Clear row removes old cells"
  );
  Assert.equal(snapshot.rows.get("1:r").cells.get("b"), "");
  Assert.equal(
    snapshot.rows.get("2:r").cells.get("a"),
    "other",
    "Clear table keeps shared rows"
  );
});

add_task(function test_strictMembershipUpdatesKeepNativeOrder() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const initial = Array.from(
    { length: 64 },
    (_, index) => "[" + (index + 1).toString(16) + "(a=v" + (index + 1) + ")]"
  ).join(" ");
  const body =
    header +
    [
      "{1:r {(k=kind)} " + initial + "}",
      "{1:r {(k=kind)} 10 10 -11 11}",
      "@$${A{@",
      "{1:r {(k=kind)} -1 1}",
      "@$$}A}@",
      "@$${B{@",
      "{1:r {(k=kind)} -2}",
      "@$$}~~}@",
      "// Layout after the abort is allowed.",
    ].join("\n");
  const snapshot = new MorkParser().parseForImport(body);
  const members = snapshot.tables.get("1:r").rows;
  Assert.ok(
    Array.isArray(members),
    "Snapshot membership keeps its public array type"
  );
  Assert.deepEqual(members, [
    ...Array.from({ length: 63 }, (_, index) => index + 2)
      .filter(key => key != 17)
      .map(key => key + ":r"),
    "17:r",
    "1:r",
  ]);
  Assert.equal(snapshot.rows.get("2:r").cells.get("a"), "v2");
  Assert.equal(snapshot.rows.size, 64);
});

add_task(function test_strictRejectsRowsAfterAbort() {
  const before =
    '// <!-- <mdb:mork:z v="1.4"/> -->\n' +
    ["[1:r(a=before)]", "@$${A{@", "[1:r(a=aborted)]", "@$$}~~}@", ""].join(
      "\n"
    );
  Assert.throws(
    () => new MorkParser().parseForImport(before + "[2:r(a=later)]"),
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.offset == before.length,
    "Later rows cannot produce a successful stale snapshot"
  );
});

add_task(function test_strictRejectsGroupsAfterAbort() {
  const before =
    '// <!-- <mdb:mork:z v="1.4"/> -->\n' +
    ["[1:r(a=before)]", "@$${A{@", "[1:r(a=aborted)]", "@$$}~~}@", ""].join(
      "\n"
    );
  Assert.throws(
    () =>
      new MorkParser().parseForImport(
        before + "@$${B{@\n[1:r(a=later)]\n@$$}B}@"
      ),
    error =>
      error.name == "MorkImportError" &&
      error.code == "UNSUPPORTED_MORK" &&
      error.offset == before.length,
    "A later committed group cannot hide an earlier aborted write"
  );
});

add_task(function test_strictRecordedFormFailures() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const columns = "< <(a=c)> (80=UTF-8)(81=UTF-16)>\n";
  for (const [body, code] of [
    ["[1:r[(f^81)](a=value)]", "UNSUPPORTED_MORK"],
    ["<(90<(f^81)>=value)>", "UNSUPPORTED_MORK"],
    ["[1:r[(f^FF)](a=value)]", "MALFORMED_MORK"],
    ["<(90<(f^FF)>=value)>", "MALFORMED_MORK"],
    ["[1:r[(a=v)](a=value)]", "UNSUPPORTED_MORK"],
    ["[1:r[(f=1)](a=value)]", "UNSUPPORTED_MORK"],
    ["[1:r[(f^80)](a=value)", "TRUNCATED_MORK"],
    ["<(90<(f^80)>=value)", "TRUNCATED_MORK"],
  ]) {
    const input = header + columns + body;
    let snapshot = null;
    Assert.throws(
      () => {
        snapshot = new MorkParser().parseForImport(input);
      },
      error =>
        error.name == "MorkImportError" &&
        error.code == code &&
        Number.isInteger(error.offset) &&
        error.offset >= 0 &&
        error.offset <= input.length,
      body
    );
    Assert.equal(
      snapshot,
      null,
      "Invalid forms never return a partial snapshot"
    );
  }
});

add_task(function test_strictRowPositionFailures() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  // Grammar-unit controls check native hexadecimal positions and end clamping.
  const initial = Array.from(
    { length: 12 },
    (_, i) => "[" + (i + 1).toString(16) + "(a=v)]"
  ).join(" ");
  const snapshot = new MorkParser().parseForImport(
    header + "{1:r {(k=kind)} " + initial + " 1 !a 2 !7fffffff}"
  );
  Assert.deepEqual(snapshot.tables.get("1:r").rows, [
    "3:r",
    "4:r",
    "5:r",
    "6:r",
    "7:r",
    "8:r",
    "9:r",
    "10:r",
    "11:r",
    "1:r",
    "12:r",
    "2:r",
  ]);
  for (const [body, code] of [
    ["{1:r {(k=kind)} [1(a=v)] 1 !z}", "MALFORMED_MORK"],
    ["{1:r {(k=kind)} [1(a=v)] 1 !100000000}", "MALFORMED_MORK"],
    ["{1:r {(k=kind)} [1(a=v)] 1 !80000000}", "UNSUPPORTED_MORK"],
    ["[1:r(a=v)] !0", "UNSUPPORTED_MORK"],
    ["{1:r {(k=kind)[1(a=v)] !0}}", "UNSUPPORTED_MORK"],
    ["{1:r {(k=kind)} [1(a=v)] -1 !0}", "UNSUPPORTED_MORK"],
    ["{1:r {(k=kind)} [1(a=v)] 1 !", "TRUNCATED_MORK"],
  ]) {
    let partial = null;
    Assert.throws(
      () => {
        partial = new MorkParser().parseForImport(header + body);
      },
      error => error.name == "MorkImportError" && error.code == code,
      body
    );
    Assert.equal(
      partial,
      null,
      "Invalid moves never return partial membership"
    );
  }
});

add_task(function test_strictDictionaryFormWithFollowingAliases() {
  // Grammar-unit regression: native dictionaries can have aliases after a form.
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const columns = "< <(a=c)> (80=r)(81=k)(82=Payload)(83=Other)(85=UTF-8)>\n";
  const table = "{1:^80 {(k^81:c)(s=9)} [1(^82^81)(^83^82)]}";
  for (const following of ["(82=y)", "(82<(f^0)>=y)"]) {
    const input =
      header + columns + "<(81\n<(f^85)>=x)" + following + ">\n" + table;
    const snapshot = new MorkParser().parseForImport(input);
    Assert.deepEqual(
      [...snapshot.rows.get("1:r").cells],
      [
        ["Payload", "x"],
        ["Other", "y"],
      ]
    );
    Assert.deepEqual(snapshot.tables.get("1:r").rows, ["1:r"]);
  }
  for (const [following, code] of [
    ["(82=y)", "TRUNCATED_MORK"],
    ["(82<(f^FF)>=y)>", "MALFORMED_MORK"],
  ]) {
    let partial = null;
    Assert.throws(
      () => {
        partial = new MorkParser().parseForImport(
          header + columns + "<(81<(f^85)>=x)" + following
        );
      },
      error => error.name == "MorkImportError" && error.code == code,
      "A following invalid alias or missing dictionary end is not partial success"
    );
    Assert.equal(partial, null);
  }
});

/**
 * Requires a complete import failure at an exact original byte offset.
 *
 * @param {string} body - Literal grammar-unit input, not a legacy fixture.
 * @param {Record<string, number>} limits - Bounds for this import.
 * @param {string} code - Exact structured failure code.
 * @param {number} offset - Expected source byte position.
 */
function assertStrictImportFailure(body, limits, code, offset) {
  let partial = null;
  Assert.throws(
    () => {
      partial = new MorkParser().parseForImport(body, body.length, limits);
    },
    error =>
      error.name === "MorkImportError" &&
      error.code === code &&
      error.offset === offset,
    "The intended complete import fails with the exact code and byte offset"
  );
  Assert.equal(
    partial,
    null,
    "An over-limit or malformed import has no snapshot"
  );
}

add_task(function test_strictInputSizeAndLimitArguments() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const parser = new MorkParser();
  Assert.equal(parser.parseForImport(header, header.length).rows.size, 0);
  assertStrictImportFailure(
    header,
    { maxTokenBytes: 32 },
    "RESOURCE_LIMIT",
    32
  );
  Assert.throws(
    () => parser.parseForImport(header + " ", header.length),
    error =>
      error.name === "MorkImportError" &&
      error.code === "RESOURCE_LIMIT" &&
      error.offset === 0
  );
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    Assert.throws(
      () => parser.parseForImport(header, value),
      error =>
        error.name === "RangeError" &&
        error.message === "Invalid Mork input limit"
    );
    for (const name of [
      "maxTokenBytes",
      "maxTokens",
      "maxAtoms",
      "maxRows",
      "maxCommentDepth",
      "maxBlockDepth",
    ]) {
      Assert.throws(
        () => parser.parseForImport(header, header.length, { [name]: value }),
        error =>
          error.name === "RangeError" && error.message === "Invalid " + name
      );
    }
  }
  for (const limits of [null, false, 1, "limits", []]) {
    Assert.throws(
      () => parser.parseForImport(header, header.length, limits),
      error =>
        error.name === "TypeError" && error.message === "Expected Mork limits"
    );
  }
});

add_task(function test_strictTokenSpanLimits() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const parser = new MorkParser();
  // Every complete-document test must admit the 33-byte header comment first.
  for (const [payload, expected] of [
    ["x".repeat(62), "x".repeat(62)],
    ["$41".repeat(20) + "yz", "A".repeat(20) + "yz"],
    ["a\\\r\n" + "x".repeat(58), "a" + "x".repeat(58)],
  ]) {
    const body = header + "[1:r(a=" + payload + ")]";
    const snapshot = parser.parseForImport(body, body.length, {
      maxTokenBytes: 64,
    });
    Assert.equal(snapshot.rows.size, 1);
    Assert.equal(snapshot.rows.get("1:r").cells.get("a"), expected);
    assertStrictImportFailure(
      header + "[1:r(a=" + payload + "x)]",
      { maxTokenBytes: 64 },
      "RESOURCE_LIMIT",
      header.length + 6 + 64
    );
  }
  const column = "a".repeat(64);
  const named = header + "[1:r(" + column + "=)]";
  Assert.ok(
    parser
      .parseForImport(named, named.length, { maxTokenBytes: 64 })
      .rows.get("1:r")
      .cells.has(column)
  );
  assertStrictImportFailure(
    header + "[1:r(" + column + "a=)]",
    { maxTokenBytes: 64 },
    "RESOURCE_LIMIT",
    header.length + 5 + 64
  );
  const comment = "/*" + "x".repeat(60) + "*/";
  const commented = header + comment;
  Assert.equal(
    parser.parseForImport(commented, commented.length, { maxTokenBytes: 64 })
      .rows.size,
    0
  );
  assertStrictImportFailure(
    header + "/*" + "x".repeat(61) + "*/",
    { maxTokenBytes: 64 },
    "RESOURCE_LIMIT",
    header.length + 64
  );
  const defaultValue = header + "[1:r(a=" + "x".repeat(65534) + ")]";
  Assert.equal(
    parser.parseForImport(defaultValue).rows.get("1:r").cells.get("a").length,
    65534
  );
  assertStrictImportFailure(
    header + "[1:r(a=" + "x".repeat(65535) + ")]",
    {},
    "RESOURCE_LIMIT",
    header.length + 6 + 65536
  );
});

add_task(function test_strictAtomAndRowBudgets() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const parser = new MorkParser();
  const aliases = header + "<(80=x)(81=y)>[1:r(a^80)(b^81)]";
  Assert.deepEqual(
    [
      ...parser
        .parseForImport(aliases, aliases.length, { maxAtoms: 2 })
        .rows.get("1:r").cells,
    ],
    [
      ["a", "x"],
      ["b", "y"],
    ]
  );
  assertStrictImportFailure(
    header + "<(80=x)(81=y)(82=z)>",
    { maxAtoms: 2 },
    "RESOURCE_LIMIT",
    header.length + 13
  );
  const columns = "< <(a=c)> (80=col)>";
  const domains = header + columns + "<(80=v)>[1:r(^80^80)]";
  Assert.equal(
    parser
      .parseForImport(domains, domains.length, { maxAtoms: 2 })
      .rows.get("1:r")
      .cells.get("col"),
    "v"
  );
  assertStrictImportFailure(
    domains,
    { maxAtoms: 1 },
    "RESOURCE_LIMIT",
    header.length + columns.length + 1
  );
  const duplicate = header + "<(80=x)><(80=x)>[1:r(a^80)]";
  Assert.equal(
    parser
      .parseForImport(duplicate, duplicate.length, { maxAtoms: 1 })
      .rows.get("1:r")
      .cells.get("a"),
    "x"
  );
  const rows = header + "[1:r][2:r]";
  Assert.equal(
    parser.parseForImport(rows, rows.length, { maxRows: 2 }).rows.size,
    2
  );
  assertStrictImportFailure(
    rows,
    { maxRows: 1 },
    "RESOURCE_LIMIT",
    header.length + 5
  );
  const cutPrefix = header + "{1:r {(k=kind)} -1 -";
  assertStrictImportFailure(
    cutPrefix + "2}",
    { maxRows: 1 },
    "RESOURCE_LIMIT",
    cutPrefix.length
  );
});

add_task(function test_strictTokenBudget() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const parser = new MorkParser();
  Assert.equal(
    parser.parseForImport(header, header.length, { maxTokens: 1 }).rows.size,
    0
  );
  const oneRow = header + "[1:r]";
  Assert.equal(
    parser.parseForImport(oneRow, oneRow.length, { maxTokens: 4 }).rows.size,
    1
  );
  assertStrictImportFailure(
    oneRow,
    { maxTokens: 3 },
    "RESOURCE_LIMIT",
    header.length + 4
  );
  const repeats = header + "[1:r]".repeat(64);
  Assert.equal(
    parser.parseForImport(repeats, repeats.length, {
      maxTokens: 256,
      maxRows: 1,
    }).rows.size,
    1
  );
  assertStrictImportFailure(
    repeats + "[1:r]",
    { maxTokens: 256 },
    "RESOURCE_LIMIT",
    repeats.length
  );
});

add_task(function test_strictNestingLimits() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const parser = new MorkParser();
  const rowForm = header + "[1:r[(f^0)]]";
  Assert.equal(
    parser.parseForImport(rowForm, rowForm.length, { maxBlockDepth: 2 }).rows
      .size,
    1
  );
  assertStrictImportFailure(
    rowForm,
    { maxBlockDepth: 1 },
    "RESOURCE_LIMIT",
    header.length + 4
  );
  const comments = header + "/*a/*b*/c*/[1:r]";
  Assert.equal(
    parser.parseForImport(comments, comments.length, { maxCommentDepth: 2 })
      .rows.size,
    1
  );
  assertStrictImportFailure(
    comments,
    { maxCommentDepth: 1 },
    "RESOURCE_LIMIT",
    header.length + 3
  );
  const exactComments = header + "/*".repeat(16) + "*/".repeat(16);
  Assert.equal(parser.parseForImport(exactComments).rows.size, 0);
  assertStrictImportFailure(
    header + "/*".repeat(17) + "*/".repeat(17),
    {},
    "RESOURCE_LIMIT",
    header.length + 32
  );
  assertStrictImportFailure(
    header + "[".repeat(8192),
    {},
    "RESOURCE_LIMIT",
    header.length + 16
  );
});

add_task(function test_strictMalformedOffsetsAndBoundedInput() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  assertStrictImportFailure(
    header + "[1:r(a=$Q0)]",
    {},
    "MALFORMED_MORK",
    header.length + 8
  );
  assertStrictImportFailure(
    header + "[1:r(a=$0Q)]",
    {},
    "MALFORMED_MORK",
    header.length + 9
  );
  const prefix = header + "[1:r(a=\xC3\xA9\\\r\n$0";
  assertStrictImportFailure(
    prefix + "Q)]",
    {},
    "MALFORMED_MORK",
    prefix.length
  );
  assertStrictImportFailure(
    header + "[1:r(a=value)",
    {},
    "TRUNCATED_MORK",
    header.length
  );
  // A strict error never builds recovery's map of every delimiter in a comment.
  assertStrictImportFailure(
    header + "< /*" + "<".repeat(2048) + "*/",
    {},
    "TRUNCATED_MORK",
    header.length
  );
});

add_task(function test_strictRepeatedMembershipBounds() {
  const header = '// <!-- <mdb:mork:z v="1.4"/> -->\n';
  const prefix = header + "{1:r {(k=kind)} [1(a=first)] [2(a=second)] ";
  const input = prefix + "1 1 -1 1 ".repeat(2048) + "}";
  const snapshot = new MorkParser().parseForImport(input, input.length, {
    maxRows: 2,
  });
  Assert.equal(
    snapshot.rows.size,
    2,
    "Repeated membership does not expand rows"
  );
  Assert.deepEqual(snapshot.tables.get("1:r").rows, ["2:r", "1:r"]);
  Assert.deepEqual([...snapshot.rows.get("1:r").cells], [["a", "first"]]);
  Assert.deepEqual([...snapshot.rows.get("2:r").cells], [["a", "second"]]);
  Assert.equal(
    input,
    prefix + "1 1 -1 1 ".repeat(2048) + "}",
    "Raw input stays exact"
  );
  assertStrictImportFailure(
    input + "[3:r]",
    { maxRows: 2 },
    "RESOURCE_LIMIT",
    input.length
  );
});
