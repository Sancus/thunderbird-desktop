/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

add_task(async function test_getUrlForUriEws() {
  const service = Cc[
    "@mozilla.org/messenger/messageservice;1?type=ews"
  ].createInstance(Ci.nsIMsgMessageService);

  const ewsMessageUrl = service.getUrlForUri(
    "ews-message://name@localhost/some/folder",
    null
  );
  Assert.equal(ewsMessageUrl.scheme, "x-moz-ews", "ews-message -> x-moz-ews");

  const xMozEwsUrl = service.getUrlForUri(
    "x-moz-ews://name@localhost/some/folder",
    null
  );
  Assert.equal(xMozEwsUrl.scheme, "x-moz-ews", "x-moz-ews -> x-moz-ews");
});

add_task(async function test_getUrlForUriGraph() {
  const service = Cc[
    "@mozilla.org/messenger/messageservice;1?type=graph"
  ].createInstance(Ci.nsIMsgMessageService);

  const graphMessageUrl = service.getUrlForUri(
    "graph-message://name@localhost/some/folder",
    null
  );
  Assert.equal(
    graphMessageUrl.scheme,
    "x-moz-graph",
    "graph-message -> x-moz-graph"
  );

  const xMozGraphUrl = service.getUrlForUri(
    "x-moz-graph://name@localhost/some/folder",
    null
  );
  Assert.equal(
    xMozGraphUrl.scheme,
    "x-moz-graph",
    "x-moz-graph -> x-moz-graph"
  );
});

add_task(function test_unopenedChannelIsNotCanceled() {
  for (const scheme of ["x-moz-ews", "x-moz-graph"]) {
    const channel = Services.io.newChannelFromURI(
      Services.io.newURI(`${scheme}://name@localhost/folder/1`),
      null,
      Services.scriptSecurityManager.getSystemPrincipal(),
      null,
      Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      Ci.nsIContentPolicy.TYPE_OTHER
    );
    Assert.ok(!channel.canceled, "An unopened channel is not canceled");
    Assert.ok(!channel.isPending(), "An unopened channel is not pending");
  }
});
