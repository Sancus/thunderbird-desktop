/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from head.js */

var { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
var { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
var { OpenPGPTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mail/OpenPGPTestUtils.sys.mjs"
);
var { SmimeUtils } = ChromeUtils.importESModule(
  "resource://testing-common/mailnews/SmimeUtils.sys.mjs"
);

const SMIME_DATA_DIR = "../../../../../mailnews/test/data/smime/";
const OPENPGP_TEST_DIR = "../../../../test/browser/openpgp";

const OPENPGP_KEY_PATH = PathUtils.join(
  do_get_file(OPENPGP_TEST_DIR).path,
  "data",
  "keys",
  "alice@openpgp.example-0xf231550c4f47e38e-secret.asc"
);

/**
 * Read the values that change whenever the S/MIME test data is regenerated, from
 * a message's canonical source in mailnews/test/data/smime, so this test does
 * not hardcode them (bug 2012823).
 *
 * @param {string} fileName - A file name inside SMIME_DATA_DIR. The file must be
 *   a message whose body is a single base64-encoded PKCS#7 blob.
 * @returns {Promise<object>} An object with:
 *   - date {string}: the Date header value.
 *   - derSize {integer}: the decoded (binary) size of the base64 body, which is
 *     what the messages API reports as the size of the PKCS#7 part.
 *   - bodyLines {string[]}: the base64 body lines (the PKCS#7 blob as stored).
 */
async function readSmimeExpectations(fileName) {
  const lines = (
    await IOUtils.readUTF8(do_get_file(SMIME_DATA_DIR + fileName).path)
  ).split(/\r?\n/);

  // The file must be headers, a blank line, then a single base64 body. If its
  // structure ever changes, fail loudly here instead of silently deriving a
  // wrong expectation.
  const headerEnd = lines.indexOf("");
  if (headerEnd < 1) {
    throw new Error(`${fileName}: no header/body separator (blank line) found`);
  }

  const dateLine = lines
    .slice(0, headerEnd)
    .find(line => line.startsWith("Date: "));
  if (!dateLine) {
    throw new Error(`${fileName}: no Date header found`);
  }
  const date = dateLine.slice("Date: ".length);

  const bodyLines = lines.slice(headerEnd + 1).filter(line => line.length);
  if (!bodyLines.length) {
    throw new Error(`${fileName}: no base64 body found`);
  }

  // The messages API reports the decoded (binary) size of the PKCS#7 part.
  // Decoding also validates that the body really is base64.
  let derSize;
  try {
    derSize = atob(bodyLines.join("")).length;
  } catch {
    throw new Error(
      `${fileName}: body is not valid base64 (unexpected structure)`
    );
  }
  return { date, derSize, bodyLines };
}

add_setup(async () => {
  await Services.logins.initializationPromise;
  // Prepare OpenPGP messages.
  await OpenPGPTestUtils.initOpenPGP();

  const _account = await createAccount();
  const _identity = addIdentity(_account);
  const [id] = await OpenPGPTestUtils.importPrivateKey(
    null,
    new FileUtils.File(OPENPGP_KEY_PATH)
  );
  _identity.setUnicharAttribute("openpgp_key_id", id);

  const _test1 = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test1"
  );
  await createMessageFromFile(
    _test1,
    do_get_file("messages/encryptedNestedMessages.eml").path
  );

  const _test2 = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test2"
  );
  await createMessageFromFile(
    _test2,
    do_get_file("messages/msg-with-enc-openpgp-attachment.eml").path
  );

  const _test3 = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test3"
  );
  await createMessageFromFile(
    _test3,
    do_get_file("messages/msg-with-enc-openpgp-inline.eml").path
  );

  // Prepare SMIME messages.
  SmimeUtils.ensureNSS();

  SmimeUtils.loadPEMCertificate(
    do_get_file(SMIME_DATA_DIR + "TestCA.pem"),
    Ci.nsIX509Cert.CA_CERT
  );
  SmimeUtils.loadCertificateAndKey(
    do_get_file(SMIME_DATA_DIR + "Alice.p12"),
    "nss"
  );
  SmimeUtils.loadCertificateAndKey(
    do_get_file(SMIME_DATA_DIR + "Bob.p12"),
    "nss"
  );

  const _test4 = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test4"
  );
  const message4 = await IOUtils.readUTF8(
    do_get_file(SMIME_DATA_DIR + "alice.env.eml").path
  );
  // The message does not have a Message-ID header, which will cause issues for
  // our NNTP test server. Add it manually.
  await createMessageFromString(
    _test4,
    "Message-ID: <test4@sample.message>\r\n" + message4
  );

  const _test5 = await createSubfolder(
    _account.incomingServer.rootFolder,
    "test5"
  );
  const message5 = await IOUtils.readUTF8(
    do_get_file(SMIME_DATA_DIR + "alice.sig.SHA256.opaque.env.eml").path
  );
  // The message does not have a Message-ID header, which will cause issues for
  // our NNTP test server. Add it manually.
  await createMessageFromString(
    _test5,
    "Message-ID: <test5@sample.message>\r\n" + message5
  );
});

/**
 * Test an OpenPGP/MIME encrypted message with nested attachments.
 */

/**
 * Test an OpenPGP/INLINE encrypted message.
 */

/**
 * Test a message with an OpenPGP encrypted attachment.
 */

/**
 * Test an S/MIME encrypted message.
 */

/**
 * Test an S/MIME encrypted and signed message.
 */

/**
 * Test deleting an attachment from an S/MIME encrypted message.
 */

/**
 * Test deleting an attachment from an OpenPGP encrypted message.
 */
