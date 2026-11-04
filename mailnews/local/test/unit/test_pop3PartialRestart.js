/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const PARTIAL =
  "From: partial@example.invalid\r\n" +
  "To: original@example.invalid\r\n" +
  "Subject: Partial shell\r\n" +
  "Message-ID: <completed-partial@example.invalid>\r\n" +
  "Date: Wed, 10 Jun 2026 12:00:00 +0000\r\n" +
  "References: <old-root@example.invalid>\r\n\r\n" +
  "Truncated body.\r\n";
const COMPLETE =
  "From: complete@example.invalid\r\n" +
  "To: recipient@example.invalid\r\n" +
  "Cc: copy@example.invalid\r\n" +
  "Bcc: hidden@example.invalid\r\n" +
  "Subject: Completed partial\r\n" +
  "Message-ID: <completed-partial@example.invalid>\r\n" +
  "Date: Wed, 10 Jun 2026 13:00:00 +0000\r\n" +
  "References: <root@example.invalid> <parent@example.invalid> <root@example.invalid>\r\n" +
  "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
  "Completed body.\r\nSecond completed line.\r\n";


/**
 * Complete a real Partial in one process and read its persisted row in another.
 *
 * @param {string} store - Native provider selected in both processes.
 * @returns {Promise<void>} Both independent process lifetimes have ended.
 */
async function checkPartialProcessRestart(store) {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  const resources = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  const profilePath = PathUtils.join(
    do_get_profile().path,
    "partial-process-restart-" + store
  );
  await IOUtils.makeDirectory(profilePath);
  registerCleanupFunction(() =>
    IOUtils.remove(profilePath, { recursive: true })
  );
  for (const stage of ["write", "read"]) {
    const child = await Subprocess.call({
      command: Services.dirsvc.get("XREExeF", Ci.nsIFile).path,
      arguments: [
        "-g",
        Services.dirsvc.get("GreD", Ci.nsIFile).path,
        "-a",
        Services.dirsvc.get("XCurProcD", Ci.nsIFile).path,
        "-e",
        `const pop3RestartInput = ${JSON.stringify({
          stage,
          store,
          profilePath,
          testingCommon: resources.getSubstitution("testing-common").spec,
          partial: PARTIAL,
          complete: COMPLETE,
        })};`,
        "-f",
        do_get_file("data/pop3PartialRestartChild.js").path,
      ],
      stderr: "stdout",
    });
    let output = "";
    try {
      for (let chunk; (chunk = await child.stdout.readString()); ) {
        output += chunk;
      }
      const { exitCode } = await child.wait();
      Assert.equal(
        exitCode,
        0,
        `${store} ${stage} exit=${exitCode}: ${JSON.stringify(output)}`
      );
      Assert.ok(output.includes(`POP3-PARTIAL-RESTART ${stage} PASS`));
    } finally {
      if (child.exitCode === null) {
        await child.kill();
      }
    }
  }
}

add_task(async function test_partialPhysicalAssociationAfterRestartMbox() {
  await checkPartialProcessRestart("mbox");
});

add_task(async function test_partialPhysicalAssociationAfterRestartMaildir() {
  await checkPartialProcessRestart("maildir");
});
