/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * The account manager cannot be created while a selected Panorama profile is
 * still starting, which a migration can make last minutes. One failed attempt
 * must not leave MailServices.accounts undefined for the rest of the session.
 */

add_task(function test_accountsIsTriedAgainAfterAFailedStart() {
  const contract = "@mozilla.org/messenger/account-manager;1";
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  const original = registrar.contractIDToCID(contract);
  const cid = Services.uuid.generateUUID();
  let starting = true;
  let created = 0;
  const service = {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgAccountManager"]),
  };
  const factory = {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    createInstance(iid) {
      if (starting) {
        throw Components.Exception("", Cr.NS_ERROR_NOT_AVAILABLE);
      }
      created++;
      return service.QueryInterface(iid);
    },
  };
  registrar.registerFactory(cid, "account manager", contract, factory);
  registerCleanupFunction(() => {
    registrar.unregisterFactory(cid, factory);
    registrar.registerFactory(original, "", contract, null);
  });

  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  Assert.throws(() => MailServices.accounts, /NS_ERROR_NOT_AVAILABLE/);
  Assert.throws(
    () => MailServices.accounts,
    /NS_ERROR_NOT_AVAILABLE/,
    "A failed start is an error each time, never an undefined service"
  );
  starting = false;
  const accounts = MailServices.accounts;
  Assert.ok(accounts, "The service is there once it can start");
  starting = true;
  Assert.strictEqual(MailServices.accounts, accounts, "and it is kept");
  Assert.equal(created, 1);
});
