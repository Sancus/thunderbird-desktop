/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Pop3Client } from "resource:///modules/Pop3Client.sys.mjs";

/**
 * @implements {nsIPop3Service}
 */
export class Pop3Service {
  QueryInterface = ChromeUtils.generateQI(["nsIPop3Service"]);

  constructor() {
    this._listeners = new Set();
  }

  GetNewMail(msgWindow, urlListener, inbox, server) {
    this._getMail(true, msgWindow, urlListener, inbox, server);
  }

  CheckForNewMail(msgWindow, urlListener, inbox, server) {
    this._getMail(false, msgWindow, urlListener, inbox, server);
  }

  verifyLogon(server, urlListener, msgWindow) {
    const client = new Pop3Client(server);
    client.urlListener = urlListener;
    client.connect();
    client.onOpen = () => {
      client.verifyLogon(msgWindow);
    };
    return client.runningUri;
  }

  addListener(listener) {
    this._listeners.add(listener);
  }

  removeListener(listener) {
    this._listeners.remove(listener);
  }

  notifyDownloadStarted(folder) {
    for (const listener of this._listeners) {
      listener.onDownloadStarted(folder);
    }
  }

  notifyDownloadProgress(folder, numMessages, numTotalMessages) {
    for (const listener of this._listeners) {
      listener.onDownloadProgress(folder, numMessages, numTotalMessages);
    }
  }

  notifyDownloadCompleted(folder, numMessages) {
    for (const listener of this._listeners) {
      listener.onDownloadCompleted(folder, numMessages);
    }
  }

  /**
   * Retains this request's URI and listener before queuing client construction.
   * Reports setup rejection through the same once-only URL listener used by the
   * real client. Active client IO keeps its ordinary completion callbacks.
   *
   * @param {boolean} downloadNewMail - Whether to download new message bodies.
   * @param {nsIMsgWindow} msgWindow - The request's message window.
   * @param {?nsIUrlListener} urlListener - The original completion listener.
   * @param {nsIMsgFolder} inbox - The delivery folder.
   * @param {nsIPop3IncomingServer} server - The server whose client queue is used.
   * @throws {nsIException} If offline or synchronous admission/setup fails.
   */
  _getMail(downloadNewMail, msgWindow, urlListener, inbox, server) {
    if (Services.io.offline) {
      throw Components.Exception(
        "Cannot get mail while offline",
        Cr.NS_MSG_ERROR_OFFLINE
      );
    }
    const incoming = server.QueryInterface(Ci.nsIMsgIncomingServer);
    const uri = Services.io
      .newURI(`pop3://${incoming.hostname}:${incoming.port}`)
      .QueryInterface(Ci.nsIMsgMailNewsUrl);
    uri.msgWindow = msgWindow;
    let started = false;
    let stopped = false;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
      OnStartRunningUrl(url, status) {
        if (started || stopped) {
          return;
        }
        started = true;
        urlListener?.OnStartRunningUrl(url, status);
      },
      OnStopRunningUrl(url, status) {
        if (stopped) {
          return;
        }
        // Set before user code. Reentrant cancellation or a later native
        // cleanup callback must not deliver another terminal for this request.
        stopped = true;
        urlListener?.OnStopRunningUrl(url, status);
      },
    };
    /**
     * Delivers the actual setup error without losing a listener cleanup error.
     *
     * @param {Error|nsIException} error - The original rejected setup outcome.
     */
    const rejected = error => {
      try {
        listener.OnStopRunningUrl(uri, error.result || Cr.NS_ERROR_FAILURE);
      } catch (cleanup) {
        // The server retains this same rejection object for native settlement.
        // Listener failure is secondary to the real refusal/setup error.
        error.secondaryErrors = [...(error.secondaryErrors || []), cleanup];
      }
    };
    let pending;
    try {
      pending = server.wrappedJSObject.withClient(client => {
        client.runningUri = uri;
        client.urlListener = listener;
        client.onOpen = () => {
          client.getMail(downloadNewMail, msgWindow, inbox);
        };
      });
    } catch (error) {
      rejected(error);
      throw error;
    }
    // Install before returning to the event loop. A queued refusal calls the
    // original listener before the server's joined settlement Promise resolves.
    // No rejected queue Promise is left unobserved and no new client is needed.
    pending.catch(rejected);
  }
}

Pop3Service.prototype.classID = Components.ID(
  "{1e8f21c3-32c3-4114-9ea4-3d74006fb351}"
);
