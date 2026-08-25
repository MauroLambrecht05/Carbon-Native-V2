// net_shim.js — installs Web-compatible fetch / Response / Headers /
// AbortController / WebSocket on `globalThis`, wiring them through the
// `__cm_*` host imports registered by `runtime/host/native/net.rs`.
//
// All async events from the Rust tokio runtime arrive here via the four
// dispatcher functions at the bottom (`__cm_fetch_dispatch_*` /
// `__cm_ws_dispatch_*`); the main-thread event loop eval's a call to
// the matching dispatcher for each UserEvent::Fetch* / Ws* it receives.
//
// QuickJS doesn't ship atob / btoa / DOMException — we add minimal
// versions inline. TextDecoder isn't exposed either, so we inline a
// UTF-8 decoder for `Response.text()` and WebSocket text frames.

(function () {
  "use strict";

  // ─── base64 helpers ─────────────────────────────────────────────────────
  // Used to ferry binary fetch / WS payloads through the JS string
  // boundary losslessly. Standard RFC 4648 alphabet; standard
  // 4-char-per-3-byte packing.
  var B64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function btoaShim(input) {
    var out = "";
    var i = 0;
    var len = input.length;
    while (i < len) {
      var a = input.charCodeAt(i++);
      var b = i < len ? input.charCodeAt(i++) : NaN;
      var c = i < len ? input.charCodeAt(i++) : NaN;
      out += B64.charAt(a >> 2);
      out += B64.charAt(((a & 0x3) << 4) | (isNaN(b) ? 0 : b >> 4));
      out += isNaN(b) ? "=" : B64.charAt(((b & 0xf) << 2) | (isNaN(c) ? 0 : c >> 6));
      out += isNaN(c) ? "=" : B64.charAt(c & 0x3f);
    }
    return out;
  }

  function atobShim(input) {
    input = String(input).replace(/[^A-Za-z0-9+/=]/g, "");
    var out = "";
    var i = 0;
    var len = input.length;
    while (i < len) {
      var c1 = B64.indexOf(input.charAt(i++));
      var c2 = B64.indexOf(input.charAt(i++));
      var c3 = B64.indexOf(input.charAt(i++));
      var c4 = B64.indexOf(input.charAt(i++));
      out += String.fromCharCode((c1 << 2) | (c2 >> 4));
      if (c3 !== 64 && c3 !== -1) out += String.fromCharCode(((c2 & 0xf) << 4) | (c3 >> 2));
      if (c4 !== 64 && c4 !== -1) out += String.fromCharCode(((c3 & 0x3) << 6) | c4);
    }
    return out;
  }

  if (typeof globalThis.atob === "undefined") globalThis.atob = atobShim;
  if (typeof globalThis.btoa === "undefined") globalThis.btoa = btoaShim;

  // base64 → Uint8Array
  function b64ToBytes(b64) {
    var bin = atobShim(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Uint8Array → base64
  function bytesToB64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoaShim(bin);
  }

  // ─── UTF-8 decode (Response.text + WS text frames) ──────────────────────
  // Handles 1-4 byte sequences. Invalid bytes become U+FFFD.
  function utf8Decode(bytes) {
    var s = "";
    var i = 0;
    while (i < bytes.length) {
      var b1 = bytes[i++];
      if (b1 < 0x80) {
        s += String.fromCharCode(b1);
      } else if (b1 < 0xc0) {
        s += "�";
      } else if (b1 < 0xe0) {
        var b2 = bytes[i++] & 0x3f;
        s += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
      } else if (b1 < 0xf0) {
        var b2b = bytes[i++] & 0x3f;
        var b3 = bytes[i++] & 0x3f;
        s += String.fromCharCode(((b1 & 0x0f) << 12) | (b2b << 6) | b3);
      } else {
        var b2c = bytes[i++] & 0x3f;
        var b3b = bytes[i++] & 0x3f;
        var b4 = bytes[i++] & 0x3f;
        var cp = ((b1 & 0x07) << 18) | (b2c << 12) | (b3b << 6) | b4;
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return s;
  }

  // ─── DOMException (minimal) ─────────────────────────────────────────────
  if (typeof globalThis.DOMException === "undefined") {
    globalThis.DOMException = function DOMException(message, name) {
      var err = new Error(message);
      err.name = name || "Error";
      return err;
    };
  }

  // ─── Headers ────────────────────────────────────────────────────────────
  // Spec-shape: case-insensitive lookup, multi-value via append.
  function Headers(init) {
    this._m = new Map(); // lowercased name → [orig name, value]
    if (init) {
      if (init instanceof Headers) {
        var self = this;
        init.forEach(function (v, k) { self.append(k, v); });
      } else if (Array.isArray(init)) {
        for (var i = 0; i < init.length; i++) this.append(init[i][0], init[i][1]);
      } else {
        for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) this.append(k, init[k]);
      }
    }
  }
  Headers.prototype.append = function (name, value) {
    var k = String(name).toLowerCase();
    var prev = this._m.get(k);
    var v = prev ? prev[1] + ", " + String(value) : String(value);
    this._m.set(k, [String(name), v]);
  };
  Headers.prototype.set = function (name, value) {
    this._m.set(String(name).toLowerCase(), [String(name), String(value)]);
  };
  Headers.prototype.get = function (name) {
    var e = this._m.get(String(name).toLowerCase());
    return e ? e[1] : null;
  };
  Headers.prototype.has = function (name) { return this._m.has(String(name).toLowerCase()); };
  Headers.prototype.delete = function (name) { this._m.delete(String(name).toLowerCase()); };
  Headers.prototype.forEach = function (cb, thisArg) {
    this._m.forEach(function (pair) { cb.call(thisArg, pair[1], pair[0], this); });
  };
  Headers.prototype.entries = function () {
    var arr = [];
    this._m.forEach(function (pair) { arr.push([pair[0], pair[1]]); });
    return arr[Symbol.iterator]();
  };
  Headers.prototype.keys = function () {
    var arr = [];
    this._m.forEach(function (pair) { arr.push(pair[0]); });
    return arr[Symbol.iterator]();
  };
  Headers.prototype.values = function () {
    var arr = [];
    this._m.forEach(function (pair) { arr.push(pair[1]); });
    return arr[Symbol.iterator]();
  };
  Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
  globalThis.Headers = Headers;

  // ─── AbortController / AbortSignal ──────────────────────────────────────
  function AbortSignal() {
    this.aborted = false;
    this.reason = undefined;
    this.onabort = null;
    this._listeners = new Set();
  }
  AbortSignal.prototype.addEventListener = function (type, cb) {
    if (type === "abort") this._listeners.add(cb);
  };
  AbortSignal.prototype.removeEventListener = function (type, cb) {
    if (type === "abort") this._listeners.delete(cb);
  };
  AbortSignal.prototype.throwIfAborted = function () { if (this.aborted) throw this.reason; };
  AbortSignal.prototype._fire = function (reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason || new DOMException("The operation was aborted.", "AbortError");
    var ev = { type: "abort", target: this };
    if (typeof this.onabort === "function") { try { this.onabort(ev); } catch (e) {} }
    this._listeners.forEach(function (cb) { try { cb(ev); } catch (e) {} });
  };
  function AbortController() { this.signal = new AbortSignal(); }
  AbortController.prototype.abort = function (reason) { this.signal._fire(reason); };
  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;

  // ─── Fetch state ────────────────────────────────────────────────────────
  // id → pending fetch record:
  //   { resolve, reject, response, chunks: Uint8Array[],
  //     chunkReaders: [{resolve,reject}, ...], done, error,
  //     bodyConsumers: [resolve, ...] }
  var fetches = new Map();

  // ─── Request ────────────────────────────────────────────────────────────
  // Minimal subset of the WHATWG Request type. The AI SDK and other
  // libraries construct `new Request(url, init)` and pass it to fetch()
  // instead of calling fetch(url, init) directly. We only need to surface
  // .url and .init back to fetch() — Request is otherwise opaque.
  function Request(input, init) {
    var src;
    if (input instanceof Request) {
      src = { url: input.url, init: input._init || {} };
    } else if (typeof input === "string") {
      src = { url: input, init: {} };
    } else if (input && typeof input.url === "string") {
      src = { url: input.url, init: {} };
    } else {
      throw new TypeError("Request: first arg must be a string or Request");
    }
    var merged = {};
    var k;
    for (k in src.init) merged[k] = src.init[k];
    if (init) for (k in init) merged[k] = init[k];
    this.url = src.url;
    this.method = merged.method || "GET";
    this.headers = merged.headers instanceof Headers
      ? merged.headers
      : new Headers(merged.headers || {});
    this.body = merged.body == null ? null : merged.body;
    this.signal = merged.signal || null;
    this.credentials = merged.credentials || "same-origin";
    this.mode = merged.mode || "cors";
    this.referrer = merged.referrer || "";
    this.redirect = merged.redirect || "follow";
    this.cache = merged.cache || "default";
    this._init = merged;
  }
  Request.prototype.clone = function () {
    return new Request(this.url, this._init);
  };
  globalThis.Request = Request;

  function Response(init) {
    this.status = init.status;
    this.statusText = init.statusText || "";
    this.ok = init.status >= 200 && init.status < 300;
    this.headers = init.headers;
    this.url = init.url || "";
    this.type = "basic";
    this.redirected = !!init.redirected;
    this._id = init.id;
    this._bodyUsed = false;
  }
  Object.defineProperty(Response.prototype, "bodyUsed", {
    get: function () { return this._bodyUsed; },
  });
  Object.defineProperty(Response.prototype, "body", {
    get: function () {
      var self = this;
      var id = self._id;
      return {
        getReader: function () {
          if (self._bodyUsed) throw new TypeError("body already used");
          self._bodyUsed = true;
          return {
            read: function () {
              return new Promise(function (resolve, reject) {
                var p = fetches.get(id);
                if (!p) return resolve({ done: true, value: undefined });
                if (p.error) return reject(p.error);
                if (p.chunks.length > 0) return resolve({ done: false, value: p.chunks.shift() });
                if (p.done) return resolve({ done: true, value: undefined });
                p.chunkReaders.push({ resolve: resolve, reject: reject });
              });
            },
            cancel: function () {
              __cm_fetch_abort(id);
              fetches.delete(id);
              return Promise.resolve();
            },
            releaseLock: function () {},
          };
        },
      };
    },
  });
  Response.prototype._collectBytes = function () {
    if (this._bodyUsed) return Promise.reject(new TypeError("body already used"));
    this._bodyUsed = true;
    var id = this._id;
    var p = fetches.get(id);
    if (!p) return Promise.resolve(new Uint8Array(0));
    return new Promise(function (resolve, reject) {
      function flush() {
        if (p.error) return reject(p.error);
        if (!p.done) return;
        var total = 0;
        for (var i = 0; i < p.chunks.length; i++) total += p.chunks[i].length;
        var out = new Uint8Array(total);
        var off = 0;
        for (var j = 0; j < p.chunks.length; j++) {
          out.set(p.chunks[j], off);
          off += p.chunks[j].length;
        }
        p.chunks = [];
        resolve(out);
      }
      if (p.done || p.error) return flush();
      p.bodyConsumers.push({ flush: flush, reject: reject });
    });
  };
  Response.prototype.arrayBuffer = function () {
    return this._collectBytes().then(function (b) { return b.buffer; });
  };
  Response.prototype.bytes = function () { return this._collectBytes(); };
  Response.prototype.text = function () {
    return this._collectBytes().then(function (b) { return utf8Decode(b); });
  };
  Response.prototype.json = function () {
    return this.text().then(function (s) { return JSON.parse(s); });
  };
  /**
   * Clone the response. Must be called before the body is read; the
   * clone shares the underlying byte buffer until one side starts
   * consuming, at which point we materialise both copies.
   *
   * Retry middleware in @ai-sdk/* / @vercel/ai / undici-style fetch
   * pollyfills calls this to inspect a response's status / headers
   * before deciding whether to retry — without `clone()` the second
   * read throws "body already used".
   */
  Response.prototype.clone = function () {
    if (this._bodyUsed) throw new TypeError("Response: body already used");
    var src = this;
    var p = fetches.get(src._id);
    // For a shared body, we need both clones to see every chunk. We
    // intercept the original record's chunkReaders so each pushed
    // chunk fans out to the clone's own buffer.
    var cloneId = "clone:" + src._id + ":" + Math.random().toString(36).slice(2, 10);
    var cloneRecord = {
      resolve: function () {}, reject: function () {},
      response: null,
      chunks: p ? p.chunks.slice() : [],
      chunkReaders: [],
      bodyConsumers: [],
      done: p ? p.done : true,
      error: p ? p.error : null,
      url: src.url,
    };
    fetches.set(cloneId, cloneRecord);
    // Hook into the original to mirror future chunks into the clone.
    if (p && !p.done) {
      var origDispatch = p._cloneTaps || (p._cloneTaps = []);
      origDispatch.push(cloneId);
    }
    var cloneResp = new Response({
      status: src.status,
      statusText: src.statusText,
      headers: src.headers,
      id: cloneId,
      url: src.url,
      redirected: src.redirected,
    });
    return cloneResp;
  };
  globalThis.Response = Response;

  // ─── fetch ──────────────────────────────────────────────────────────────
  function fetch(input, init) {
    init = init || {};
    // Accept `Request` instances as the first arg by lifting their fields
    // into `init`. Caller-supplied `init` overrides Request properties
    // (per spec: "Init takes precedence over the Request" for fields the
    // caller explicitly sets).
    if (input && typeof input === "object" && input instanceof Request) {
      var merged = { method: input.method, headers: input.headers, body: input.body, signal: input.signal };
      for (var ik in init) if (Object.prototype.hasOwnProperty.call(init, ik)) merged[ik] = init[ik];
      init = merged;
    }
    return new Promise(function (resolve, reject) {
      var url = typeof input === "string" ? input : input.url;
      var signal = init.signal;

      // Headers normalize → flat array of [k, v] pairs.
      var headersArr = [];
      if (init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach(function (v, k) { headersArr.push([k, v]); });
        } else if (Array.isArray(init.headers)) {
          for (var i = 0; i < init.headers.length; i++) {
            headersArr.push([String(init.headers[i][0]), String(init.headers[i][1])]);
          }
        } else {
          for (var k in init.headers) {
            if (Object.prototype.hasOwnProperty.call(init.headers, k)) {
              headersArr.push([k, String(init.headers[k])]);
            }
          }
        }
      }

      // Body: string passes through; binary base64-encoded with __b64: prefix.
      var body = null;
      if (init.body != null) {
        if (typeof init.body === "string") {
          body = init.body;
        } else if (init.body instanceof Uint8Array) {
          body = "__b64:" + bytesToB64(init.body);
        } else if (init.body instanceof ArrayBuffer) {
          body = "__b64:" + bytesToB64(new Uint8Array(init.body));
        } else if (init.body && init.body.buffer instanceof ArrayBuffer) {
          body = "__b64:" + bytesToB64(new Uint8Array(init.body.buffer));
        } else if (init.body && typeof init.body.toString === "function") {
          body = init.body.toString();
        } else {
          return reject(new TypeError("Unsupported body type"));
        }
      }

      var initJson = JSON.stringify({
        method: init.method || "GET",
        headers: headersArr,
        body: body,
      });
      var id = __cm_fetch_start(url, initJson);
      var record = {
        resolve: resolve,
        reject: reject,
        response: null,
        chunks: [],
        chunkReaders: [],
        bodyConsumers: [],
        done: false,
        error: null,
        url: url,
      };
      fetches.set(id, record);

      if (signal) {
        if (signal.aborted) {
          __cm_fetch_abort(id);
          fetches.delete(id);
          return reject(signal.reason || new DOMException("aborted", "AbortError"));
        }
        signal.addEventListener("abort", function () {
          __cm_fetch_abort(id);
          var err = signal.reason || new DOMException("aborted", "AbortError");
          var p = fetches.get(id);
          if (!p) return;
          p.error = err;
          if (!p.response) p.reject(err);
          while (p.chunkReaders.length) p.chunkReaders.shift().reject(err);
          while (p.bodyConsumers.length) p.bodyConsumers.shift().reject(err);
          fetches.delete(id);
        });
      }
    });
  }
  globalThis.fetch = fetch;

  // ─── fetchWithStoredCredential ─────────────────────────────────────────
  // The credential-broker path — not a web-standard API, so it's a
  // deliberately Carbon-named global rather than living on `fetch` itself.
  // The stored secret never enters this function, never enters JS at all:
  // it's looked up and substituted into the header by Rust, server-side of
  // this boundary. Same request/response machinery as fetch() otherwise —
  // reuses the same `fetches` map and dispatch handlers below.
  function fetchWithStoredCredential(url, credential, init) {
    init = init || {};
    return new Promise(function (resolve, reject) {
      var headersArr = [];
      if (init.headers) {
        for (var k in init.headers) {
          if (Object.prototype.hasOwnProperty.call(init.headers, k)) {
            headersArr.push([k, String(init.headers[k])]);
          }
        }
      }
      var body = typeof init.body === "string" ? init.body : null;
      var initJson = JSON.stringify({ method: init.method || "GET", headers: headersArr, body: body });
      var id = __cm_fetch_start_with_credential(
        url,
        initJson,
        credential.service,
        credential.account,
        credential.headerName || "Authorization",
        credential.headerTemplate || "Bearer {}",
      );
      fetches.set(id, {
        resolve: resolve,
        reject: reject,
        response: null,
        chunks: [],
        chunkReaders: [],
        bodyConsumers: [],
        done: false,
        error: null,
        url: url,
      });
    });
  }
  globalThis.__carbon_fetch_with_stored_credential = fetchWithStoredCredential;

  // ─── Fetch dispatchers (called by main-thread event loop) ───────────────
  globalThis.__cm_fetch_dispatch_headers = function (id, status, headersArr) {
    var p = fetches.get(id);
    if (!p) return;
    var hs = new Headers();
    for (var i = 0; i < headersArr.length; i++) hs.append(headersArr[i][0], headersArr[i][1]);
    var resp = new Response({ status: status, headers: hs, id: id, url: p.url });
    p.response = resp;
    p.resolve(resp);
  };
  globalThis.__cm_fetch_dispatch_chunk = function (id, b64) {
    var p = fetches.get(id);
    if (!p) return;
    var bytes = b64ToBytes(b64);
    if (p.chunkReaders.length > 0) {
      p.chunkReaders.shift().resolve({ done: false, value: bytes });
    } else {
      p.chunks.push(bytes);
    }
    // Mirror to any clones — each gets the same chunk.
    if (p._cloneTaps) {
      for (var i = 0; i < p._cloneTaps.length; i++) {
        var clone = fetches.get(p._cloneTaps[i]);
        if (!clone) continue;
        if (clone.chunkReaders.length > 0) {
          clone.chunkReaders.shift().resolve({ done: false, value: bytes });
        } else {
          clone.chunks.push(bytes);
        }
      }
    }
  };
  globalThis.__cm_fetch_dispatch_end = function (id) {
    var p = fetches.get(id);
    if (!p) return;
    p.done = true;
    while (p.chunkReaders.length) p.chunkReaders.shift().resolve({ done: true, value: undefined });
    while (p.bodyConsumers.length) {
      var c = p.bodyConsumers.shift();
      try { c.flush(); } catch (e) { c.reject(e); }
    }
    if (p._cloneTaps) {
      for (var j = 0; j < p._cloneTaps.length; j++) {
        var clone2 = fetches.get(p._cloneTaps[j]);
        if (!clone2) continue;
        clone2.done = true;
        while (clone2.chunkReaders.length) clone2.chunkReaders.shift().resolve({ done: true, value: undefined });
        while (clone2.bodyConsumers.length) {
          var c2 = clone2.bodyConsumers.shift();
          try { c2.flush(); } catch (e) { c2.reject(e); }
        }
      }
    }
    if (p.response && p.response._bodyUsed) fetches.delete(id);
  };
  globalThis.__cm_fetch_dispatch_error = function (id, message) {
    var p = fetches.get(id);
    if (!p) return;
    var err = new TypeError(message || "fetch failed");
    p.error = err;
    if (!p.response) { p.reject(err); }
    while (p.chunkReaders.length) p.chunkReaders.shift().reject(err);
    while (p.bodyConsumers.length) p.bodyConsumers.shift().reject(err);
    fetches.delete(id);
  };

  // ─── WebSocket ──────────────────────────────────────────────────────────
  var wsMap = new Map();
  function WebSocket(url /*, protocols */) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.bufferedAmount = 0;
    this.binaryType = "arraybuffer";
    this.extensions = "";
    this.protocol = "";
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._L = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
    this._id = __cm_ws_connect(url);
    wsMap.set(this._id, this);
  }
  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;
  WebSocket.prototype.addEventListener = function (type, cb) {
    if (this._L[type]) this._L[type].add(cb);
  };
  WebSocket.prototype.removeEventListener = function (type, cb) {
    if (this._L[type]) this._L[type].delete(cb);
  };
  WebSocket.prototype._fire = function (type, ev) {
    var handler = this["on" + type];
    if (typeof handler === "function") { try { handler(ev); } catch (e) {} }
    this._L[type].forEach(function (cb) { try { cb(ev); } catch (e) {} });
  };
  WebSocket.prototype.send = function (data) {
    if (this.readyState !== 1) throw new DOMException("WebSocket not open", "InvalidStateError");
    if (typeof data === "string") {
      __cm_ws_send_text(this._id, data);
    } else if (data instanceof Uint8Array) {
      __cm_ws_send_binary_b64(this._id, bytesToB64(data));
    } else if (data instanceof ArrayBuffer) {
      __cm_ws_send_binary_b64(this._id, bytesToB64(new Uint8Array(data)));
    } else if (data && data.buffer instanceof ArrayBuffer) {
      __cm_ws_send_binary_b64(this._id, bytesToB64(new Uint8Array(data.buffer)));
    } else {
      throw new TypeError("Unsupported data type for WebSocket.send");
    }
  };
  WebSocket.prototype.close = function (code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    __cm_ws_close(this._id, code == null ? 1000 : code, reason == null ? "" : String(reason));
  };
  globalThis.WebSocket = WebSocket;

  // ─── WebSocket dispatchers ──────────────────────────────────────────────
  globalThis.__cm_ws_dispatch_open = function (id) {
    var ws = wsMap.get(id);
    if (!ws) return;
    ws.readyState = 1;
    ws._fire("open", { type: "open", target: ws });
  };
  globalThis.__cm_ws_dispatch_message = function (id, b64, isText) {
    var ws = wsMap.get(id);
    if (!ws) return;
    var data;
    var bytes = b64ToBytes(b64);
    if (isText) {
      data = utf8Decode(bytes);
    } else if (ws.binaryType === "arraybuffer") {
      data = bytes.buffer;
    } else {
      data = bytes;
    }
    ws._fire("message", { type: "message", target: ws, data: data });
  };
  globalThis.__cm_ws_dispatch_close = function (id, code, reason) {
    var ws = wsMap.get(id);
    if (!ws) return;
    ws.readyState = 3;
    wsMap.delete(id);
    ws._fire("close", {
      type: "close", target: ws,
      code: code, reason: reason || "",
      wasClean: code === 1000,
    });
  };
  globalThis.__cm_ws_dispatch_error = function (id, message) {
    var ws = wsMap.get(id);
    if (!ws) return;
    ws._fire("error", { type: "error", target: ws, message: message });
  };
})();
