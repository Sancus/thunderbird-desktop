/*
 * Test suite for getting news urls via the protocol handler.
 */

var defaultProtocolFlags =
  Ci.nsIProtocolHandler.URI_NORELATIVE |
  Ci.nsIProtocolHandler.URI_LOADABLE_BY_ANYONE |
  Ci.nsIProtocolHandler.ALLOWS_PROXY |
  Ci.nsIProtocolHandler.URI_FORBIDS_AUTOMATIC_DOCUMENT_REPLACEMENT |
  Ci.nsIProtocolHandler.URI_FORBIDS_COOKIE_ACCESS |
  Ci.nsIProtocolHandler.ORIGIN_IS_FULL_SPEC;

var protocols = [
  {
    protocol: "news",
    urlSpec: "news://user@localhost/",
    defaultPort: Ci.nsINntpIncomingServer.DEFAULT_NNTP_PORT,
  },
  {
    protocol: "snews",
    urlSpec: "snews://user@localhost/",
    defaultPort: Ci.nsINntpIncomingServer.DEFAULT_NNTPS_PORT,
  },
  {
    protocol: "nntp",
    urlSpec: "nntp://user@localhost/",
    defaultPort: Ci.nsINntpIncomingServer.DEFAULT_NNTP_PORT,
  },
];

function run_test() {
  for (var part = 0; part < protocols.length; ++part) {
    print("protocol: " + protocols[part].protocol);

    var pH = Cc[
      "@mozilla.org/network/protocol;1?name=" + protocols[part].protocol
    ].createInstance(Ci.nsIProtocolHandler);

    Assert.equal(pH.scheme, protocols[part].protocol);
    Assert.equal(
      Services.io.getDefaultPort(pH.scheme),
      protocols[part].defaultPort
    );
    Assert.equal(Services.io.getProtocolFlags(pH.scheme), defaultProtocolFlags);

    // Whip through some of the ports to check we get the right results.
    // NEWS only overrides the restricted port list for its own ports.
    for (let i = 0; i < 1024; ++i) {
      Assert.equal(
        pH.allowPort(i, ""),
        i == Ci.nsINntpIncomingServer.DEFAULT_NNTP_PORT ||
          i == Ci.nsINntpIncomingServer.DEFAULT_NNTPS_PORT,
        "should only allow nntp ports"
      );
    }

    // Check we get a URI when we ask for one
    var uri = Services.io.newURI(protocols[part].urlSpec);

    Assert.equal(uri.spec, protocols[part].urlSpec);
  }

  testNntp();
  run_next_test();
}

/**
 * 'nntp' URIs must get a content principal so that they are kept in the parent
 * process like other news URIs.
 */
function testNntp() {
  const uri = Services.io.newURI("nntp://localhost/some.group/1");
  Assert.ok(
    uri instanceof Ci.nsIMsgMailNewsUrl,
    "nntp URI should be a mailnews URL"
  );
  Assert.ok(
    !Services.scriptSecurityManager.createContentPrincipal(uri, {})
      .isNullPrincipal,
    "nntp URI should get a content principal"
  );
}

/**
 * Create a real news account without subscribing or opening a group database.
 *
 * @param {string} hostname - Distinct hostname for this test account.
 * @returns {nsINntpIncomingServer} The account's news server.
 */
function createNewsrcServer(hostname) {
  const account = MailServices.accounts.createAccount();
  registerCleanupFunction(() =>
    MailServices.accounts.removeAccount(account, false)
  );
  const server = MailServices.accounts.createIncomingServer(
    "",
    hostname,
    "nntp"
  );
  // Configure the account before discovery enumerates groups and reads newsrc.
  server.valid = false;
  account.incomingServer = server;
  const database = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(
    Ci.nsIMsgDBService
  );
  Assert.equal(
    "nsIDatabaseCore" in Ci && database instanceof Ci.nsIDatabaseCore,
    Services.prefs.getBoolPref("mail.panorama.enabled", false),
    "The real account uses the requested active database backend"
  );
  return server.QueryInterface(Ci.nsINntpIncomingServer);
}

add_task(async function test_getNewsrcFilePathFailureRetries() {
  const server = createNewsrcServer("newsrc-retry.invalid");
  const blockedRoot = do_get_profile().clone();
  blockedRoot.normalize();
  blockedRoot.append("newsrc-root-is-a-file");
  await IOUtils.writeUTF8(blockedRoot.path, "Root path blocker");
  server.newsrcRootPath = blockedRoot;
  const invalid = blockedRoot.clone();
  invalid.append("newsrc");
  let originalError;
  Assert.throws(
    () => invalid.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o644),
    error => {
      originalError = error.result;
      return originalError !== undefined && originalError != Cr.NS_OK;
    },
    "The configured root is a real file, not a directory"
  );
  for (const attempt of [1, 2]) {
    Assert.throws(
      () => server.newsrcFilePath,
      error => error.result == originalError,
      `Lookup ${attempt} preserves the original creation failure`
    );
  }
  Assert.equal(
    server.getFileValue("newsrc.file-rel", "newsrc.file"),
    null,
    "Failed creation does not publish path preferences"
  );
  const directory = do_get_profile().clone();
  directory.normalize();
  directory.append("newsrc-retry-directory");
  directory.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  server.newsrcRootPath = directory;
  const result = server.newsrcFilePath;
  Assert.ok(
    result.exists(),
    "A new lookup succeeds after the root is repaired"
  );
  Assert.ok(result.isFile());
  Assert.equal(result.parent.path, directory.path);
  Assert.equal(server.newsrcRootPath.path, directory.path);
  Assert.equal(
    server.getFileValue("newsrc.file-rel", "newsrc.file").path,
    result.path
  );
});

add_task(async function test_setNewsrcFilePathCreatesMissingFile() {
  const server = createNewsrcServer("newsrc-create.invalid");
  const file = do_get_profile().clone();
  file.normalize();
  file.append("newsrc-explicit-path");
  Assert.ok(!file.exists(), "The selected file does not exist before setting");

  server.newsrcFilePath = file;
  Assert.ok(file.exists(), "Setting the path creates the newsrc file");
  Assert.ok(file.isFile());
  Assert.equal(server.newsrcFilePath.path, file.path);
  Assert.equal(
    server.getFileValue("newsrc.file-rel", "newsrc.file").path,
    file.path,
    "The created path is persisted in the server preferences"
  );
  Assert.equal(await IOUtils.readUTF8(file.path), "");

  const contents = "test.saved: 5-9\n";
  await IOUtils.writeUTF8(file.path, contents);
  server.newsrcFilePath = file;
  Assert.equal(server.newsrcFilePath.path, file.path);
  Assert.equal(
    await IOUtils.readUTF8(file.path),
    contents,
    "An existing file is not truncated or renamed"
  );
});

add_task(async function test_setNewsrcFilePathFailurePreservesBinding() {
  const server = createNewsrcServer("newsrc-retain.invalid");
  const file = do_get_profile().clone();
  file.normalize();
  file.append("newsrc-retained-path");
  const contents = "test.retained: 10-20\n";
  await IOUtils.writeUTF8(file.path, contents);
  server.newsrcFilePath = file;
  const invalid = file.clone();
  invalid.append("newsrc");
  let originalError;
  Assert.throws(
    () => invalid.clone().createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o644),
    error => {
      originalError = error.result;
      return originalError !== undefined && originalError != Cr.NS_OK;
    },
    "A real file cannot be used as the parent directory"
  );
  Assert.throws(
    () => {
      server.newsrcFilePath = invalid;
    },
    error => error.result == originalError,
    "The setter propagates the actual native creation error"
  );
  Assert.equal(
    server.newsrcFilePath.path,
    file.path,
    "A failed setter retains the cached binding"
  );
  Assert.equal(
    server.getFileValue("newsrc.file-rel", "newsrc.file").path,
    file.path
  );
  Assert.equal(await IOUtils.readUTF8(file.path), contents);
});
