/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

var { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);
var { SQLiteDirectory } = ChromeUtils.importESModule(
  "resource:///modules/SQLiteDirectory.sys.mjs"
);
var { AddrBookFileImporter } = ChromeUtils.importESModule(
  "resource:///modules/AddrBookFileImporter.sys.mjs"
);

/**
 * Create a temporary address book, import a source file into it, then test the
 * cards are correct.
 *
 * @param {string} type - A source file type supported by AddrBookFileImporter.
 * @param {string} filePath - The path of a source file.
 * @param {string} refDataKey - The key of an object in addressbook.json.
 * @param {string[]} [csvFieldMap] - Map of CSV fields to address book fields.
 */
async function test_importAbFile(type, filePath, refDataKey, csvFieldMap) {
  // Create an address book and init the importer.
  const dirId = MailServices.ab.newAddressBook(
    `tmp-${type}`,
    "",
    Ci.nsIAbManager.JS_DIRECTORY_TYPE
  );
  const targetDir = MailServices.ab.getDirectoryFromId(dirId);
  const importer = new AddrBookFileImporter(type);

  // Start importing.
  const sourceFile = do_get_file(filePath);
  if (type == "csv") {
    const unmatched = await importer.parseCsvFile(sourceFile);
    if (unmatched.length) {
      importer.setCsvFields(csvFieldMap);
    }
  }
  await importer.startImport(sourceFile, targetDir);

  // Read in the reference data.
  const refFile = do_get_file("resources/addressbook.json");
  const refData = JSON.parse(await IOUtils.readUTF8(refFile.path))[refDataKey];

  // Compare with the reference data.
  for (let i = 0; i < refData.length; i++) {
    const card = targetDir.childCards[i];
    for (const [key, value] of Object.entries(refData[i])) {
      if (key == "LastModifiedDate") {
        continue;
      }
      if (key == "_vCard") {
        equal(
          card
            .getProperty(key, "")
            .replace(
              /UID:[a-f0-9-]{36}/i,
              "UID:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            ),
          `BEGIN:VCARD\r\n${value.join("\r\n")}\r\nEND:VCARD\r\n`,
          "_vCard should be correct"
        );
      } else {
        equal(card.getProperty(key, ""), value, `${key} should be correct`);
      }
    }
  }
}

/** Test importing .csv file works. */
add_task(async function test_importCsvFile() {
  // A comma separated file.
  await test_importAbFile(
    "csv",
    "resources/basic_csv_addressbook.csv",
    "csv_import"
  );

  // A semicolon separated file.
  await test_importAbFile("csv", "resources/csv_semicolon.csv", "csv_import");

  // A comma separated file without header row.
  Services.prefs.setBoolPref("mail.import.csv.skipfirstrow", false);
  await test_importAbFile("csv", "resources/csv_no_header.csv", "csv_import", [
    2, // DisplayName
    0, // FirstName
    1, // LastName
    4, // PrimaryEmail
  ]);
  Services.prefs.clearUserPref("mail.import.csv.skipfirstrow");

  // A comma separated file with some fields containing quotes.
  await test_importAbFile("csv", "resources/quote.csv", "quote_csv");

  // Non-UTF8 csv file.
  await test_importAbFile(
    "csv",
    "resources/shiftjis_addressbook.csv",
    "shiftjis_csv"
  );
  await test_importAbFile(
    "csv",
    "resources/utf16_addressbook.csv",
    "utf16_csv"
  );
});

/** Test importing .vcf file works. */
add_task(async function test_importVCardFile() {
  await test_importAbFile(
    "vcard",
    "resources/basic_vcard_addressbook.vcf",
    "vcard_import"
  );

  // File with extra newlines (e.g. as copy-pasted by hand, a relatively
  // unlikely but still reasonable use case to cover).
  await test_importAbFile(
    "vcard",
    "resources/emptylines_vcard_addressbook.vcf",
    "vcard_import"
  );

  // File with \r\r\n as line breaks.
  await test_importAbFile(
    "vcard",
    "resources/dos_vcard_addressbook.vcf",
    "dos_vcard_import"
  );
});

/** Test importing .ldif file works. */
add_task(async function test_importLdifFile() {
  await test_importAbFile(
    "ldif",
    "resources/basic_ldif_addressbook.ldif",
    "basic_addressbook"
  );

  // Bug 264405: The Address Book doesn't show the LDAP-field "labeledURI" as Website
  await test_importAbFile("ldif", "resources/bug_263304.ldif", "bug_263304");
});

// Grammar fixtures exercise source-key collisions across scopes and equal
// display names/emails. The genuine saved native MAB is used by the profile test.
const MAB_SOURCE = `// <!-- <mdb:mork:z v="1.4"/> -->
< <(a=c)>(80=ns:addrbk:db:row:scope:card:all)
(81=ns:addrbk:db:row:scope:list:all)(82=ns:addrbk:db:table:kind:pab)
(83=Address1)(84=Address2)>
{1:^80 {(k^82:c)}
[1(DisplayName=Same)(PrimaryEmail=same@invalid)(UID=$EF$BB$BFone)
(RecordKey=0000000a)(Empty=)(Opaque=$EF$BB$BFopaque$00tail)]
[2(DisplayName=Same)(PrimaryEmail=same@invalid)(UID=two)(RecordKey=2)]
[1:^81(ListName=Physical list)(ListNickName=)(ListDescription=$EF$BB$BFnote)
(ListTotalAddresses=2)(^83=2)(^84=1)]}`;
let mabSerial = 0;

/**
 * Creates an independent source file and real target for one import.
 *
 * @param {string} source - Complete MAB grammar input.
 * @returns {Promise<{file: nsIFile, target: nsIAbDirectory,
 *   importer: AddrBookFileImporter, progress: number[]}>} Owned ordinary fixture.
 */
async function makeMabImport(source = MAB_SOURCE) {
  const serial = ++mabSerial;
  const file = do_get_profile().clone();
  file.append(`source-${serial}.mab`);
  await IOUtils.writeUTF8(file.path, source);
  const id = MailServices.ab.newAddressBook(
    `MAB ${serial}`,
    "",
    Ci.nsIAbManager.JS_DIRECTORY_TYPE
  );
  const target = MailServices.ab.getDirectoryFromId(id);
  registerCleanupFunction(async () => {
    MailServices.ab.deleteAddressBook(target.URI);
    await IOUtils.remove(file.path, { ignoreAbsent: true });
  });
  const progress = [];
  const importer = new AddrBookFileImporter("mab");
  importer.onProgress = current => progress.push(current);
  return { file, target, importer, progress };
}

add_task(async function test_importMabWithoutRuntimeFactory() {
  const input = await makeMabImport();
  const original = await IOUtils.read(input.file.path);
  let acquisitions = 0;
  const refusedMork = () => {
    acquisitions++;
    throw Components.Exception(
      "S603 runtime Mork acquisition",
      Cr.NS_ERROR_FAILURE
    );
  };
  const factories = [
    MockRegistrar.register(
      "@mozilla.org/import/import-ab-file;1?type=mab",
      refusedMork
    ),
    MockRegistrar.register("@mozilla.org/db/mork;1", refusedMork),
  ];
  try {
    await input.importer.startImport(input.file, input.target);
    Assert.equal(acquisitions, 0);
    Assert.deepEqual(input.progress, [2, 10]);
    const cards = input.target.childCards.filter(card => !card.isMailList);
    Assert.equal(cards.length, 2);
    Assert.deepEqual(cards.map(card => card.UID).sort(), ["two", "\uFEFFone"]);
    const first = cards.find(card => card.UID == "\uFEFFone");
    Assert.equal(first.getProperty("Opaque", "missing"), "\uFEFFopaque\0tail");
    Assert.equal(first.getPropertyAsUint32("RecordKey"), 10);
    Assert.equal(first.getPropertyAsUint32("DbRowID"), 1);
    const [list] = input.target.childNodes;
    Assert.equal(input.target.childNodes.length, 1);
    Assert.equal(list.dirName, "Physical list");
    Assert.equal(list.listNickName, "");
    Assert.equal(list.description, "\uFEFFnote");
    Assert.deepEqual(
      list.childCards.map(card => card.UID),
      ["two", "\uFEFFone"]
    );
    Assert.deepEqual(await IOUtils.read(input.file.path), original);
  } finally {
    for (const cid of factories) {
      MockRegistrar.unregister(cid);
    }
  }
});

add_task(async function test_importMabValidatesBeforeTarget() {
  for (const [source, message] of [
    [MAB_SOURCE.slice(0, -1), /Mork/],
    [MAB_SOURCE.replace("(^84=1)", "(^84=3)"), /member is missing/],
    [MAB_SOURCE.replace("(RecordKey=2)", "(RecordKey=xyz)"), /RecordKey/],
    [
      MAB_SOURCE.replace("(UID=two)", "(UID=$EF$BB$BFone)"),
      /duplicate legacy card UID/,
    ],
    [
      MAB_SOURCE.replace("(ListName=Physical list)", "(ListName=bad,name)"),
      /mailing list name/,
    ],
    [MAB_SOURCE.replace("(^83=2)", "(^83=1)"), /mailing list membership/],
    [
      MAB_SOURCE.replace(
        "(PrimaryEmail=same@invalid)(UID=two)",
        "(PrimaryEmail=)(UID=two)"
      ),
      /mailing list membership/,
    ],
    [
      MAB_SOURCE.replace("kind:pab", "kind:unknown"),
      /Unsupported address-book tables/,
    ],
    ["", /Mork/],
  ]) {
    const input = await makeMabImport(source);
    const original = await IOUtils.read(input.file.path);
    await Assert.rejects(
      input.importer.startImport(input.file, input.target),
      message
    );
    Assert.equal(input.target.childCardCount, 0);
    Assert.equal(input.target.childNodes.length, 0);
    Assert.deepEqual(input.progress, []);
    Assert.deepEqual(await IOUtils.read(input.file.path), original);
  }
});

add_task(async function test_importMabRetainsFirstStorageError() {
  const input = await makeMabImport();
  const db = SQLiteDirectory.forFile(input.target.fileName)._dbConnection;
  db.executeSimpleSQL(`CREATE TEMP TRIGGER reject_mab BEFORE INSERT ON properties
    BEGIN SELECT RAISE(ABORT, 'S603 target storage refusal'); END`);
  try {
    await Assert.rejects(
      input.importer.startImport(input.file, input.target),
      error => error.result == Cr.NS_ERROR_STORAGE_CONSTRAINT
    );
    Assert.equal(input.target.childCardCount, 0);
    Assert.equal(input.target.childNodes.length, 0);
    Assert.deepEqual(input.progress, [2]);
  } finally {
    db.executeSimpleSQL("DROP TRIGGER reject_mab");
  }
  await input.importer.startImport(input.file, input.target);
  Assert.equal(input.target.childCardCount, 2);
  Assert.equal(input.target.childNodes.length, 1);
  Assert.deepEqual(input.progress, [2, 2, 10]);
  Assert.equal(await IOUtils.readUTF8(input.file.path), MAB_SOURCE);
});

add_task(async function test_importMabRetainsReadOnlyError() {
  const input = await makeMabImport();
  Services.prefs.setBoolPref(`${input.target.dirPrefId}.readOnly`, true);
  await Assert.rejects(
    input.importer.startImport(input.file, input.target),
    /read-only/
  );
  Assert.equal(input.target.childCardCount, 0);
  Assert.equal(input.target.childNodes.length, 0);
  Assert.deepEqual(input.progress, [2]);
});

add_task(async function test_importMabWithEmptyBookAndMissingSource() {
  const empty =
    MAB_SOURCE.slice(0, MAB_SOURCE.indexOf("{")) + "{1:^80 {(k^82:c)}}";
  const input = await makeMabImport(empty);
  await input.importer.startImport(input.file, input.target);
  Assert.equal(input.target.childCardCount, 0);
  Assert.equal(input.target.childNodes.length, 0);
  Assert.deepEqual(input.progress, [2, 10]);
  input.progress.length = 0;
  input.file.remove(false);
  await Assert.rejects(
    input.importer.startImport(input.file, input.target),
    error => error.result == Cr.NS_ERROR_FILE_NOT_FOUND
  );
  Assert.equal(input.target.childCardCount, 0);
  Assert.equal(input.target.childNodes.length, 0);
  Assert.deepEqual(input.progress, []);
});
