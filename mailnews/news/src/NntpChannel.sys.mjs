/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MailChannel } from "resource:///modules/MailChannel.sys.mjs";
import { MailServices } from "resource:///modules/MailServices.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NntpUtils: "resource:///modules/NntpUtils.sys.mjs",
  captureNativeNewsArticle: "resource:///modules/NntpClient.sys.mjs",
  revalidateNativeNewsArticle: "resource:///modules/NntpClient.sys.mjs",
});

/**
 * A channel to interact with NNTP server.
 *
 * @implements {nsIChannel}
 * @implements {nsIRequest}
 * @implements {nsICacheEntryOpenCallback}
 */
export class NntpChannel extends MailChannel {
  QueryInterface = ChromeUtils.generateQI([
    "nsIMailChannel",
    "nsIChannel",
    "nsIRequest",
    "nsICacheEntryOpenCallback",
  ]);

  _logger = lazy.NntpUtils.logger;
  _status = Cr.NS_OK;

  /**
   * @param {nsIURI} uri - The uri to construct the channel from.
   * @param {nsILoadInfo} loadInfo - The loadInfo associated with the channel.
   */
  constructor(uri, loadInfo) {
    super();
    // If there's no server for this host, one is only created once the load
    // has passed the security checks, see _readFromServer.
    this._server = lazy.NntpUtils.findServer(uri.asciiHost);

    if (uri.port < 1) {
      // Ensure the uri has a port so that memory cache works.
      uri = uri
        .mutate()
        .setPort(
          this._server?.port ??
            (uri.scheme == "snews"
              ? Ci.nsINntpIncomingServer.DEFAULT_NNTPS_PORT
              : Ci.nsINntpIncomingServer.DEFAULT_NNTP_PORT)
        )
        .finalize();
    }

    // Two forms of the uri:
    // - news://news.mozilla.org:119/mailman.30.1608649442.1056.accessibility%40lists.mozilla.org?group=mozilla.accessibility&key=378
    // - news://news.mozilla.org:119/id@mozilla.org
    // And for nntp:, see RFC 5538 section 3:
    // - nntp://news.mozilla.org:119/mozilla.accessibility/378
    const url = new URL(uri.spec);
    this._groupName = url.searchParams.get("group");
    if (uri.scheme == "nntp") {
      const [groupName, articleNumber] = url.pathname.slice(1).split("/");
      this._groupName = decodeURIComponent(groupName);
      this._newsFolder = this._server?.rootFolder.getChildNamed(
        this._groupName
      );
      this._articleNumber = articleNumber;
    } else if (this._groupName) {
      this._newsFolder = this._server?.rootFolder.getChildNamed(
        decodeURIComponent(url.searchParams.get("group"))
      );
      this._articleNumber = url.searchParams.get("key");
    } else {
      this._messageId = decodeURIComponent(url.pathname.slice(1));
      if (!this._messageId.includes("@")) {
        this._groupName = this._messageId;
        this._messageId = null;
      }
    }

    // nsIChannel attributes.
    this.originalURI = uri;
    this.URI = uri.QueryInterface(Ci.nsIMsgMailNewsUrl);
    this.loadInfo = loadInfo;
    this.contentLength = 0;
  }

  /**
   * @see nsIRequest
   * @returns {string}
   */
  get name() {
    return this.URI?.spec;
  }

  /**
   * @see nsIRequest
   * @returns {boolean}
   */
  isPending() {
    return !!this._pending;
  }

  /**
   * @see nsIRequest
   * @returns {nsresult}
   */
  get status() {
    return this._status;
  }

  /**
   * @see nsIRequest
   * @param {nsresult} status
   */
  cancel(status) {
    if (!Components.isSuccessCode(this._status)) {
      return;
    }
    this._status = status;
    this._pump?.cancel(status);
  }

  /**
   * @see nsICacheEntryOpenCallback
   */
  onCacheEntryAvailable(entry, isNew, status) {
    try {
      this._revalidateNativeArticle();
    } catch (error) {
      this._failBeforeNetwork(error);
      return;
    }
    const identity = this._nativeCacheIdentity();
    if (entry && identity) {
      let stored = null;
      if (!isNew) {
        try { stored = entry.getMetaDataElement("native-news-identity"); } catch (error) {}
      }
      if (!isNew && stored != identity) {
        entry.asyncDoom(null);
        this._readFromServer();
        return;
      }
      if (isNew) {
        try { entry.setMetaDataElement("native-news-identity", identity); } catch (error) {
          entry.asyncDoom(null);
          this._readFromServer();
          return;
        }
      }
    }
    if (!Components.isSuccessCode(status)) {
      // If memory cache doesn't work, read from the server.
      this._readFromServer();
      return;
    }

    if (isNew) {
      if (Services.io.offline) {
        entry.asyncDoom(null);
        this._failBeforeNetwork(Components.Exception("News body is not cached", Cr.NS_ERROR_OFFLINE));
        return;
      }
      // It's a new entry, needs to read from the server.
      const tee = Cc[
        "@mozilla.org/network/stream-listener-tee;1"
      ].createInstance(Ci.nsIStreamListenerTee);
      const outStream = entry.openOutputStream(0, -1);
      // When the tee stream receives data from the server, it writes to both
      // the original listener and outStream (memory cache).
      tee.init(this._listener, outStream, null);
      this._listener = tee;
      this._cacheEntry = entry;
      this._readFromServer();
      return;
    }

    // It's an existing cache entry, read it from the memory cache.
    this._readFromCacheStream(entry.openInputStream(0));
  }

  onCacheEntryCheck() {
    return Ci.nsICacheEntryOpenCallback.ENTRY_WANTED;
  }

  /**
   * @see nsIChannel
   */
  get contentType() {
    return this._contentType || "message/rfc822";
  }

  set contentType(value) {
    this._contentType = value;
  }

  get isDocument() {
    return true;
  }

  /**
   * @see nsIChannel
   * @returns {nsIInputStream} A stream that blocks until data is available.
   */
  open() {
    const listener = Cc[
      "@mozilla.org/network/sync-stream-listener;1"
    ].createInstance(Ci.nsISyncStreamListener);
    this.asyncOpen(listener);
    return listener.inputStream;
  }

  asyncOpen(listener) {
    this._logger.debug("asyncOpen", this.URI.spec);
    listener = Cc["@mozilla.org/contentsecuritymanager;1"]
      .getService(Ci.nsIContentSecurityManager)
      .performSecurityCheck(this, listener);
    if (
      [this._messageId, this._groupName, this._articleNumber].some(value =>
        /[\r\n\0]/.test(value ?? "")
      )
    ) {
      throw Components.Exception(
        `Invalid news URI: ${this.URI.spec}`,
        Cr.NS_ERROR_MALFORMED_URI
      );
    }
    if (this.URI.scheme == "nntp") {
      // Unlike news: URIs, nntp: URIs only load articles from configured
      // servers, so that loading one never contacts an unknown server.
      if (!this._server) {
        throw Components.Exception(
          `Unknown news server: ${this.URI.asciiHost}`,
          Cr.NS_ERROR_UNKNOWN_HOST
        );
      }
      if (!lazy.NntpUtils.isValidArticleNumber(this._articleNumber)) {
        throw Components.Exception(
          `No valid article number in nntp URI: ${this.URI.spec}`,
          Cr.NS_ERROR_MALFORMED_URI
        );
      }
      // Articles are fetched by number through the newsgroup's folder.
      if (!this._newsFolder) {
        throw Components.Exception(
          `Not subscribed to newsgroup: ${this._groupName}`,
          Cr.NS_ERROR_NOT_AVAILABLE
        );
      }
    }
    // Configured servers may use any port, but don't let a url make us
    // connect to a port reserved for another service.
    if (
      !this._server &&
      !Services.io.allowPort(this.URI.port, this.URI.scheme)
    ) {
      throw Components.Exception(
        `Port ${this.URI.port} not allowed`,
        Cr.NS_ERROR_PORT_ACCESS_NOT_ALLOWED
      );
    }
    this._prepareNativeArticle();
    const url = new URL(this.URI.spec);
    this._listener = listener;

    if (url.searchParams.has("part")) {
      const converter = Cc["@mozilla.org/streamConverters;1"].getService(
        Ci.nsIStreamConverterService
      );
      this._listener = converter.asyncConvertData(
        "message/rfc822",
        "*/*",
        listener,
        this
      );
    }
    try {
      // Attempt to get the message from the offline storage.
      try {
        if (this._readFromOfflineStorage()) {
          return;
        }
      } catch (e) {
        this._logger.warn(e);
      }

      let uri = this.URI;
      if (url.search) {
        // A full news url may look like
        // news://<host>:119/<Msg-ID>?group=<name>&key=<key>&header=quotebody.
        // Strip presentation parameters from the cache key. Keep group and key
        // for news URLs without a message-id; nntp URLs identify the article
        // in their path.
        const query =
          this._messageId || this.URI.scheme == "nntp"
            ? ""
            : new URLSearchParams({
                group: url.searchParams.get("group") ?? "",
                key: url.searchParams.get("key") ?? "",
              }).toString();
        uri = uri.mutate().setQuery(query).finalize();
      }

      // Check if a memory cache is available for the current URI.
      MailServices.nntp.cacheStorage.asyncOpenURI(
        uri,
        "",
        Ci.nsICacheStorage.OPEN_NORMALLY,
        this
      );
    } catch (e) {
      this._logger.warn(e);
      this._readFromServer();
    }
    if (this._status == Cr.NS_ERROR_OFFLINE) {
      throw new Components.Exception(
        "The requested action could not be completed in the offline state",
        Cr.NS_ERROR_OFFLINE
      );
    }
  }

  /**
   * Separates the wire article from a local physical key before opening a body.
   * Explicit nntp URLs may have no local header; internal message URLs may not
   * substitute their physical key for a missing native article binding.
   */
  _prepareNativeArticle() {
    this._localKey = this._articleNumber;
    if (!this._newsFolder || !Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
      return;
    }
    this._localKey = null;
    if (this.URI.scheme != "nntp") {
      this._articleBinding = lazy.captureNativeNewsArticle(this._newsFolder, this._articleNumber);
    } else {
      for (const key of this._newsFolder.msgDatabase.listAllKeys()) {
        const binding = lazy.captureNativeNewsArticle(this._newsFolder, key);
        if (binding.articleNumber == Number(this._articleNumber)) {
          if (this._articleBinding) {
            throw Components.Exception("Duplicate native article mapping", Cr.NS_ERROR_FILE_CORRUPTED);
          }
          this._articleBinding = binding;
        }
      }
    }
    if (this._articleBinding) {
      this._localKey = this._articleBinding.physicalKey;
      this._articleNumber = this._articleBinding.articleNumber;
    }
  }

  /** Checks the native source and group captured before this body's I/O. */
  _revalidateNativeArticle() {
    if (this._articleBinding) {
      lazy.revalidateNativeNewsArticle(this._articleBinding);
    }
  }

  /**
   * Returns the cache metadata for this exact native physical article.
   *
   * @returns {string|null} The source/group/incarnation/key binding, if present.
   */
  _nativeCacheIdentity() {
    const b = this._articleBinding;
    return b ? JSON.stringify([b.sourceId, b.folderId, b.incarnation, b.physicalKey, b.articleNumber]) : null;
  }

  /** Releases only this channel's offline mode before completion callbacks. */
  _releaseNativeOfflineMode() {
    if (this._ownsNativeOfflineMode) {
      this._ownsNativeOfflineMode = false;
      this._newsFolder.saveArticleOffline = false;
    }
  }

  /**
   * Settles a pool failure that happened before a client owned the request.
   *
   * @param {nsIException|Error} error - The original checkout/setup failure.
   */
  _failBeforeNetwork(error) {
    if (this._completed) {
      return;
    }
    this._completed = true;
    this._releaseNativeOfflineMode();
    const status = error.result ?? Cr.NS_ERROR_FAILURE;
    this._status = status;
    const listener = this._listener;
    this._listener = null;
    this._pending = false;
    try { this.URI.SetUrlState(true, Cr.NS_OK); } catch (e) {}
    try { listener?.onStartRequest(this); } catch (e) {}
    try { listener?.onStopRequest(this, status); } finally {
      this.URI.errorCode = status;
      this.URI.SetUrlState(false, status);
    }
  }

  /**
   * The article's header may not have been downloaded, for example for an
   * nntp: URI with an article number outside the downloaded range.
   *
   * @returns {boolean} Whether the newsgroup's database has the article's
   *   header.
   */
  _hasLocalHeader() {
    this._revalidateNativeArticle();
    return this._localKey !== null && !!this._newsFolder?.msgDatabase.containsKey(this._localKey);
  }

  /**
   * Try to read the article from the offline storage.
   *
   * @returns {boolean} True if successfully read from the offline storage.
   */
  _readFromOfflineStorage() {
    if (
      !this._hasLocalHeader() ||
      !this._newsFolder.hasMsgOffline(this._localKey)
    ) {
      return false;
    }
    const hdr = this._newsFolder.GetMessageHeader(this._localKey);
    const stream = this._newsFolder.getMsgInputStream(hdr);
    this._readFromCacheStream(stream);
    return true;
  }

  /**
   * Read the article from a stream (memory cache or offline storage).
   *
   * @param {nsIInputStream} cacheStream - The input stream to read.
   */
  _readFromCacheStream(cacheStream) {
    const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
      Ci.nsIInputStreamPump
    );
    this.contentLength = 0;
    this._contentType = "";
    pump.init(cacheStream, 0, 0, true);
    this._pump = pump;
    pump.asyncRead({
      onStartRequest: () => {
        try { this._revalidateNativeArticle(); } catch (error) {
          this.cancel(error.result ?? Cr.NS_ERROR_FAILURE);
        }
        this._pending = true;
        this.URI.SetUrlState(true, Cr.NS_OK);
        this._listener.onStartRequest(this);
      },
      onStopRequest: (request, status) => {
        if (this._completed) {
          return;
        }
        this._completed = true;
        if (Components.isSuccessCode(status)) {
          try { this._revalidateNativeArticle(); } catch (error) {
            status = error.result ?? Cr.NS_ERROR_FAILURE;
          }
        }
        if (!Components.isSuccessCode(this._status)) {
          status = this._status;
        }
        this._pump = null;
        this._status = status;
        const listener = this._listener;
        this._listener = null;
        this._pending = false;
        try {
          this.loadGroup?.removeRequest(this, null, status);
        } catch (e) {}
        try {
          listener.onStopRequest(this, status);
        } finally {
          this.URI.SetUrlState(false, status);
        }
      },
      onDataAvailable: (request, stream, offset, count) => {
        try { this._revalidateNativeArticle(); } catch (error) {
          this.cancel(error.result ?? Cr.NS_ERROR_FAILURE);
          return;
        }
        this.contentLength += count;
        this._listener.onDataAvailable(this, stream, offset, count);
        try {
          if (!cacheStream.available()) {
            cacheStream.close();
          }
        } catch (e) {}
      },
    });
  }

  /**
   * Retrieve the article from the server.
   */
  _readFromServer() {
    try {
      this._startServerRead();
    } catch (error) {
      this._failBeforeNetwork(error);
    }
  }

  /** Starts the checked server request and installs its captured callbacks. */
  _startServerRead() {
    this._logger.debug("Read from server");
    if (Services.io.offline) {
      throw Components.Exception("News body is not cached", Cr.NS_ERROR_OFFLINE);
    }
    if (!this._server) {
      this._server = MailServices.accounts.createIncomingServer("", this.URI.asciiHost, "nntp")
        .QueryInterface(Ci.nsINntpIncomingServer);
      if (this.URI.scheme == "snews") {
        this._server.socketType = Ci.nsMsgSocketType.SSL;
      }
      this._server.port = this.URI.port;
    }
    const pipe = Cc["@mozilla.org/pipe;1"].createInstance(Ci.nsIPipe);
    pipe.init(true, true, 0, 0);
    const inputStream = pipe.inputStream;
    const outputStream = pipe.outputStream;
    const saveOffline = this._newsFolder && this._hasLocalHeader() &&
      this._newsFolder.shouldStoreMsgOffline(this._localKey);
    if (this._newsFolder) {
      const folder = this._newsFolder.QueryInterface(Ci.nsIMsgNewsFolder);
      if (Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
        if (saveOffline) {
          if (folder.saveArticleOffline) {
            throw Components.Exception("News download already active", Cr.NS_MSG_FOLDER_BUSY);
          }
          folder.saveArticleOffline = true;
          this._ownsNativeOfflineMode = true;
        }
      } else {
        folder.saveArticleOffline = !!saveOffline;
      }
    }
    this._server.wrappedJSObject.withClient(client => {
      client.channel = this;
      client.onDone = status => {
        if (this._completed) {
          return;
        }
        this._completed = true;
        this._releaseNativeOfflineMode();
        if (!Components.isSuccessCode(this._status)) {
          status = this._status;
        }
        this._status = status;
        try { this.loadGroup?.removeRequest(this, null, status); } catch (error) {}
        if (status != Cr.NS_OK || this.contentLength == 0) {
          this.URI.errorCode = status != Cr.NS_OK ? status : Cr.NS_ERROR_FAILURE;
          this._cacheEntry?.asyncDoom(null);
        }
        const listener = this._listener;
        this._listener = null;
        this._pending = false;
        listener?.onStopRequest(this, status);
        if (!Services.prefs.getBoolPref("mail.panorama.enabled", false)) {
          this._newsFolder?.msgDatabase.commit(Ci.nsMsgDBCommitType.kSessionCommit);
        }
      };
      client.onOpen = () => {
        try {
          if (!Components.isSuccessCode(this._status)) {
            throw Components.Exception("Cancelled news request", this._status);
          }
          this._revalidateNativeArticle();
          if (this._messageId) {
            client.getArticleByMessageId(this._messageId);
          } else {
            client.getArticleByArticleNumber(this._groupName, this._articleNumber,
              this._articleBinding ?? null, !!saveOffline);
          }
        } catch (error) {
          client._actionDone(error.result ?? Cr.NS_ERROR_FAILURE);
        }
      };
      client.onData = data => {
        if (!Components.isSuccessCode(this._status)) {
          throw Components.Exception("Cancelled news body", this._status);
        }
        this._revalidateNativeArticle();
        if (outputStream.write(data, data.length) != data.length) {
          throw Components.Exception("Short news channel write", Cr.NS_ERROR_FAILURE);
        }
        this.contentLength += data.length;
        this._listener.onDataAvailable(this, inputStream, 0, data.length);
      };
      let msgWindow;
      try { msgWindow = this.URI.msgWindow; } catch (error) {}
      client.startRunningUrl(null, msgWindow, this.URI);
      this._pending = true;
      this._listener.onStartRequest(this);
    }).catch(error => this._failBeforeNetwork(error));
  }
}
