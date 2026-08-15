// Web Streams + URL / URLSearchParams, installed onto globalThis when the
// engine has none.
//
// Extracted from install.ts, and the one piece that was never conditional on
// `document` existing: a headless bundle that only calls fetch still needs
// ReadableStream. AI SDK + fetch use ReadableStream / WritableStream /
// TransformStream pervasively, and QuickJS ships none of them — without these
// `new TransformStream()` throws ReferenceError during module init.

const g = globalThis as any;

// `BufferSource` is a lib.dom alias, and this package cannot take lib DOM —
// it IS the DOM shim. The one name actually needed is spelled out here.
type BufferSource = ArrayBufferView | ArrayBuffer;

//
// AI SDK + fetch use ReadableStream / WritableStream / TransformStream
// pervasively. QuickJS doesn't ship them; without these polyfills,
// `new TransformStream()` throws ReferenceError during module init.
// Minimal but functional: covers the standard subset that streaming
// HTTP, async iteration, and pipe chains need.
if (typeof (g as any).ReadableStream === "undefined") {
  class CarbonReadableStream<T = unknown> {
    private chunks: T[] = [];
    private ended = false;
    private errored: unknown = null;
    private pullCb: ((c: any) => any) | null = null;
    private cancelCb: ((r: unknown) => any) | null = null;
    private pendingReader: ((v: { value: T | undefined; done: boolean }) => void) | null = null;
    private pendingRejector: ((e: unknown) => void) | null = null;
    locked = false;

    constructor(source?: {
      start?: (c: any) => any;
      pull?: (c: any) => any;
      cancel?: (r: unknown) => any;
    }) {
      this.pullCb = source?.pull ?? null;
      this.cancelCb = source?.cancel ?? null;
      const controller = {
        enqueue: (chunk: T) => this._push(chunk),
        close: () => this._close(),
        error: (e: unknown) => this._error(e),
        desiredSize: 1,
      };
      try { source?.start?.(controller); } catch (e) { this._error(e); }
    }

    private _push(chunk: T) {
      if (this.pendingReader) {
        const r = this.pendingReader; this.pendingReader = null; this.pendingRejector = null;
        r({ value: chunk, done: false });
      } else {
        this.chunks.push(chunk);
      }
    }
    private _close() {
      this.ended = true;
      if (this.pendingReader) {
        const r = this.pendingReader; this.pendingReader = null; this.pendingRejector = null;
        r({ value: undefined, done: true });
      }
    }
    private _error(e: unknown) {
      this.errored = e;
      if (this.pendingRejector) {
        const rej = this.pendingRejector; this.pendingReader = null; this.pendingRejector = null;
        rej(e);
      }
    }

    getReader() {
      this.locked = true;
      const self = this;
      return {
        read(): Promise<{ value: T | undefined; done: boolean }> {
          if (self.errored) return Promise.reject(self.errored);
          if (self.chunks.length > 0) {
            return Promise.resolve({ value: self.chunks.shift(), done: false });
          }
          if (self.ended) return Promise.resolve({ value: undefined, done: true });
          // Ask source for more, then await a push.
          if (self.pullCb) {
            try { self.pullCb({ enqueue: (c: T) => self._push(c), close: () => self._close(), error: (e: any) => self._error(e), desiredSize: 1 }); } catch (e) { self._error(e); }
            if (self.errored) return Promise.reject(self.errored);
            if (self.chunks.length > 0) return Promise.resolve({ value: self.chunks.shift(), done: false });
            if (self.ended) return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => {
            self.pendingReader = resolve;
            self.pendingRejector = reject;
          });
        },
        cancel(reason: unknown) {
          self.locked = false;
          self.cancelCb?.(reason);
          self.ended = true;
          return Promise.resolve();
        },
        releaseLock() { self.locked = false; },
        get closed(): Promise<undefined> {
          return new Promise((resolve, reject) => {
            const tick = () => {
              if (self.errored) reject(self.errored);
              else if (self.ended) resolve(undefined);
              else setTimeout(tick, 16);
            };
            tick();
          });
        },
      };
    }

    cancel(reason?: unknown) {
      this.cancelCb?.(reason);
      this.ended = true;
      return Promise.resolve();
    }

    pipeThrough<U>(transform: { readable: CarbonReadableStream<U>; writable: CarbonWritableStream<T> }) {
      // Pump self → transform.writable; return transform.readable.
      const writer = transform.writable.getWriter();
      const reader = this.getReader();
      const pump = () => {
        reader.read().then((r: any) => {
          if (r.done) { writer.close(); return; }
          writer.write(r.value).then(pump).catch((e) => writer.abort(e));
        }).catch((e) => writer.abort(e));
      };
      pump();
      return transform.readable;
    }

    pipeTo(dest: CarbonWritableStream<T>) {
      const writer = dest.getWriter();
      const reader = this.getReader();
      return new Promise<void>((resolve, reject) => {
        const pump = () => {
          reader.read().then((r: any) => {
            if (r.done) { writer.close().then(() => resolve()).catch(reject); return; }
            writer.write(r.value).then(pump).catch(reject);
          }).catch(reject);
        };
        pump();
      });
    }

    [Symbol.asyncIterator]() {
      const reader = this.getReader();
      return {
        next() { return reader.read(); },
        return() { reader.releaseLock(); return Promise.resolve({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }

  class CarbonWritableStream<T = unknown> {
    private writeCb: ((c: T, ctrl: any) => any) | null = null;
    private closeCb: ((ctrl?: any) => any) | null = null;
    private abortCb: ((r: unknown) => any) | null = null;
    locked = false;

    constructor(sink?: {
      start?: (c: any) => any;
      write?: (c: T, ctrl: any) => any;
      close?: (ctrl?: any) => any;
      abort?: (r: unknown) => any;
    }) {
      this.writeCb = sink?.write ?? null;
      this.closeCb = sink?.close ?? null;
      this.abortCb = sink?.abort ?? null;
      const ctrl = { error: (e: unknown) => { this.abortCb?.(e); } };
      try { sink?.start?.(ctrl); } catch (_) {}
    }

    getWriter() {
      this.locked = true;
      const self = this;
      const ctrl = { error: (e: unknown) => { self.abortCb?.(e); } };
      return {
        write(chunk: T) {
          if (!self.writeCb) return Promise.resolve();
          try {
            const r = self.writeCb(chunk, ctrl);
            return r instanceof Promise ? r : Promise.resolve();
          } catch (e) { return Promise.reject(e); }
        },
        close() {
          if (!self.closeCb) return Promise.resolve();
          try {
            const r = self.closeCb(ctrl);
            return r instanceof Promise ? r : Promise.resolve();
          } catch (e) { return Promise.reject(e); }
        },
        abort(reason: unknown) {
          self.abortCb?.(reason);
          return Promise.resolve();
        },
        releaseLock() { self.locked = false; },
        get closed(): Promise<undefined> { return Promise.resolve(undefined); },
        get desiredSize() { return 1; },
        get ready(): Promise<undefined> { return Promise.resolve(undefined); },
      };
    }
  }

  class CarbonTransformStream<I = unknown, O = unknown> {
    readable: CarbonReadableStream<O>;
    writable: CarbonWritableStream<I>;

    constructor(transformer?: {
      start?: (c: any) => any;
      transform?: (chunk: I, c: any) => any;
      flush?: (c: any) => any;
    }) {
      let readableCtrl: any = null;
      this.readable = new CarbonReadableStream<O>({
        start(c) { readableCtrl = c; },
      });
      const controller = {
        enqueue: (chunk: O) => readableCtrl?.enqueue(chunk),
        error: (e: unknown) => readableCtrl?.error(e),
        terminate: () => readableCtrl?.close(),
      };
      try { transformer?.start?.(controller); } catch (e) { readableCtrl?.error(e); }
      this.writable = new CarbonWritableStream<I>({
        write(chunk, _ctrl) {
          if (!transformer?.transform) {
            readableCtrl?.enqueue(chunk as any);
            return Promise.resolve();
          }
          try {
            const r = transformer.transform(chunk, controller);
            return r instanceof Promise ? r : Promise.resolve();
          } catch (e) { readableCtrl?.error(e); return Promise.reject(e); }
        },
        close() {
          try {
            transformer?.flush?.(controller);
            readableCtrl?.close();
          } catch (e) { readableCtrl?.error(e); }
          return Promise.resolve();
        },
        abort(reason) {
          readableCtrl?.error(reason);
          return Promise.resolve();
        },
      });
    }
  }

  (g as any).ReadableStream = CarbonReadableStream;
  (g as any).WritableStream = CarbonWritableStream;
  (g as any).TransformStream = CarbonTransformStream;

  // TextEncoder / TextDecoder — required by streams, fetch, and AI SDK.
  // QuickJS doesn't ship them. Standards-compliant UTF-8 implementation;
  // no other encodings supported (which matches the WHATWG spec for
  // TextEncoder, which is UTF-8-only). TextDecoder accepts any label
  // but treats everything as UTF-8 — apps that need real ISO-8859 etc.
  // should bring their own decoder.
  if (typeof (g as any).TextEncoder === "undefined") {
    class CarbonTextEncoder {
      readonly encoding = "utf-8";
      encode(input = ""): Uint8Array {
        const s = String(input);
        const out: number[] = [];
        for (let i = 0; i < s.length; i++) {
          let c = s.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const c2 = s.charCodeAt(i + 1);
            if (c2 >= 0xdc00 && c2 <= 0xdfff) {
              c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
              i++;
            }
          }
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
          else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        return new Uint8Array(out);
      }
      encodeInto(source: string, dest: Uint8Array): { read: number; written: number } {
        const bytes = this.encode(source);
        const n = Math.min(bytes.length, dest.length);
        for (let i = 0; i < n; i++) dest[i] = bytes[i];
        return { read: source.length, written: n };
      }
    }
    class CarbonTextDecoder {
      readonly encoding: string;
      readonly fatal: boolean;
      readonly ignoreBOM: boolean;
      constructor(label = "utf-8", options?: { fatal?: boolean; ignoreBOM?: boolean }) {
        this.encoding = String(label).toLowerCase();
        this.fatal = !!options?.fatal;
        this.ignoreBOM = !!options?.ignoreBOM;
      }
      decode(input?: BufferSource | null, _options?: { stream?: boolean }): string {
        if (!input) return "";
        let bytes: Uint8Array;
        if (input instanceof Uint8Array) bytes = input;
        else if ((input as any).buffer) bytes = new Uint8Array((input as any).buffer, (input as any).byteOffset || 0, (input as any).byteLength);
        else bytes = new Uint8Array(input as ArrayBuffer);
        let out = "";
        let i = 0;
        // Skip BOM (EF BB BF) unless ignoreBOM is set.
        if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          i = 3;
        }
        while (i < bytes.length) {
          const b = bytes[i++];
          if (b < 0x80) { out += String.fromCharCode(b); }
          else if (b < 0xc0) { out += "�"; }
          else if (b < 0xe0) {
            const b2 = bytes[i++] ?? 0;
            out += String.fromCharCode(((b & 0x1f) << 6) | (b2 & 0x3f));
          } else if (b < 0xf0) {
            const b2 = bytes[i++] ?? 0, b3 = bytes[i++] ?? 0;
            out += String.fromCharCode(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
          } else {
            const b2 = bytes[i++] ?? 0, b3 = bytes[i++] ?? 0, b4 = bytes[i++] ?? 0;
            const cp = ((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
            const hi = 0xd800 + ((cp - 0x10000) >> 10);
            const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
            out += String.fromCharCode(hi, lo);
          }
        }
        return out;
      }
    }
    (g as any).TextEncoder = CarbonTextEncoder;
    (g as any).TextDecoder = CarbonTextDecoder;
    if (g.window) {
      g.window.TextEncoder = CarbonTextEncoder;
      g.window.TextDecoder = CarbonTextDecoder;
    }
  }

  // ─── URL / URLSearchParams ──────────────────────────────────────────────
  // QuickJS doesn't ship these. AI-SDK, fetch wrappers, and most network
  // helpers depend on them at module init. Minimal but standards-aligned
  // parser — covers protocol/host/path/search/hash decomposition,
  // searchParams iteration + mutation, and toString re-assembly.
  if (typeof (g as any).URL === "undefined") {
    class CarbonURLSearchParams {
      private params: Array<[string, string]> = [];
      constructor(init?: string | Array<[string, string]> | Record<string, string> | CarbonURLSearchParams) {
        if (typeof init === "string") {
          let s = init;
          if (s.startsWith("?")) s = s.slice(1);
          if (s) {
            for (const pair of s.split("&")) {
              const eq = pair.indexOf("=");
              const k = eq < 0 ? decodeURIComponent(pair) : decodeURIComponent(pair.slice(0, eq));
              const v = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
              this.params.push([k, v]);
            }
          }
        } else if (Array.isArray(init)) {
          for (const [k, v] of init) this.params.push([String(k), String(v)]);
        } else if (init && typeof init === "object" && !(init instanceof CarbonURLSearchParams)) {
          for (const k of Object.keys(init)) this.params.push([k, String((init as any)[k])]);
        } else if (init instanceof CarbonURLSearchParams) {
          this.params = (init as any).params.slice();
        }
      }
      append(key: string, value: string) { this.params.push([key, String(value)]); }
      delete(key: string) { this.params = this.params.filter(([k]) => k !== key); }
      get(key: string): string | null { const e = this.params.find(([k]) => k === key); return e ? e[1] : null; }
      getAll(key: string): string[] { return this.params.filter(([k]) => k === key).map(([, v]) => v); }
      has(key: string): boolean { return this.params.some(([k]) => k === key); }
      set(key: string, value: string) { this.delete(key); this.append(key, value); }
      sort() { this.params.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }
      keys() { return this.params.map(([k]) => k)[Symbol.iterator](); }
      values() { return this.params.map(([, v]) => v)[Symbol.iterator](); }
      entries() { return this.params[Symbol.iterator](); }
      forEach(cb: (v: string, k: string, p: CarbonURLSearchParams) => void) {
        for (const [k, v] of this.params) cb(v, k, this);
      }
      [Symbol.iterator]() { return this.entries(); }
      toString() {
        return this.params
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
      }
      get size() { return this.params.length; }
    }

    class CarbonURL {
      protocol = "";
      username = "";
      password = "";
      host = "";
      hostname = "";
      port = "";
      pathname = "/";
      search = "";
      hash = "";
      searchParams: CarbonURLSearchParams;

      constructor(url: string | CarbonURL, base?: string | CarbonURL) {
        this.searchParams = new CarbonURLSearchParams();
        let s = typeof url === "string" ? url : (url as any).toString();
        if (base !== undefined) {
          const b = typeof base === "string" ? base : (base as any).toString();
          // Crude join: if s is absolute, ignore base.
          if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(s)) {
            if (s.startsWith("/")) {
              const m = b.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^\/]+)/);
              s = m ? m[1] + s : s;
            } else {
              const trimmedBase = b.replace(/[^\/]*$/, "");
              s = trimmedBase + s;
            }
          }
        }
        this._parse(s);
        // Sync searchParams.
        const sp = new CarbonURLSearchParams(this.search);
        this.searchParams = new Proxy(sp, {
          get: (t, p) => (t as any)[p],
          set: (t, p, v) => { (t as any)[p] = v; this._syncSearch(t); return true; },
        }) as any;
        // Wire mutations through proxy too — calls that change params
        // need to update this.search. We override via prototype on
        // the instance directly for the methods that mutate.
        const mutating = ["append", "delete", "set", "sort"];
        for (const m of mutating) {
          const orig = (sp as any)[m].bind(sp);
          (this.searchParams as any)[m] = (...args: any[]) => {
            const r = orig(...args);
            this._syncSearch(sp);
            return r;
          };
        }
      }

      private _parse(s: string) {
        // protocol:
        const protoMatch = s.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/);
        if (!protoMatch) throw new TypeError(`Invalid URL: ${s}`);
        this.protocol = protoMatch[1].toLowerCase() + ":";
        let rest = s.slice(protoMatch[0].length);
        if (rest.startsWith("//")) {
          rest = rest.slice(2);
          const slash = rest.search(/[/?#]/);
          const auth = slash < 0 ? rest : rest.slice(0, slash);
          rest = slash < 0 ? "" : rest.slice(slash);
          // userinfo@host:port
          const at = auth.lastIndexOf("@");
          let hostPort = auth;
          if (at >= 0) {
            const userinfo = auth.slice(0, at);
            const colon = userinfo.indexOf(":");
            this.username = colon < 0 ? userinfo : userinfo.slice(0, colon);
            this.password = colon < 0 ? "" : userinfo.slice(colon + 1);
            hostPort = auth.slice(at + 1);
          }
          const colonPort = hostPort.lastIndexOf(":");
          if (colonPort > 0 && /^\d+$/.test(hostPort.slice(colonPort + 1))) {
            this.hostname = hostPort.slice(0, colonPort);
            this.port = hostPort.slice(colonPort + 1);
            this.host = hostPort;
          } else {
            this.hostname = hostPort;
            this.host = hostPort;
          }
        }
        const hashIdx = rest.indexOf("#");
        if (hashIdx >= 0) {
          this.hash = rest.slice(hashIdx);
          rest = rest.slice(0, hashIdx);
        }
        const qIdx = rest.indexOf("?");
        if (qIdx >= 0) {
          this.search = rest.slice(qIdx);
          rest = rest.slice(0, qIdx);
        }
        this.pathname = rest || "/";
      }

      private _syncSearch(sp: CarbonURLSearchParams) {
        const s = sp.toString();
        this.search = s ? "?" + s : "";
      }

      get href(): string { return this.toString(); }
      set href(value: string) { this._parse(value); }
      get origin(): string {
        if (this.protocol === "file:") return "null";
        return `${this.protocol}//${this.host}`;
      }
      toString(): string {
        const auth = this.username
          ? `${this.username}${this.password ? ":" + this.password : ""}@`
          : "";
        return `${this.protocol}//${auth}${this.host}${this.pathname}${this.search}${this.hash}`;
      }
      toJSON(): string { return this.toString(); }

      static createObjectURL(_obj: unknown): string { return "blob:carbon-mini/0"; }
      static revokeObjectURL(_url: string): void {}
      static canParse(url: string, base?: string): boolean {
        try { new CarbonURL(url, base); return true; } catch { return false; }
      }
    }

    (g as any).URL = CarbonURL;
    (g as any).URLSearchParams = CarbonURLSearchParams;
    if (g.window) {
      g.window.URL = CarbonURL;
      g.window.URLSearchParams = CarbonURLSearchParams;
    }
  }
  // Expose on window too for libraries that reach through it.
  if (g.window) {
    g.window.ReadableStream = CarbonReadableStream;
    g.window.WritableStream = CarbonWritableStream;
    g.window.TransformStream = CarbonTransformStream;
  }

  // Common text decoders/encoders that often pair with streams. QuickJS
  // provides TextEncoder/TextDecoder natively in newer builds; only
  // install fallbacks if missing.
  if (typeof (g as any).TextDecoderStream === "undefined") {
    class CarbonTextDecoderStream extends CarbonTransformStream<Uint8Array, string> {
      constructor(label = "utf-8", _options?: any) {
        const decoder = new (g as any).TextDecoder(label);
        super({
          transform(chunk, c) { c.enqueue(decoder.decode(chunk, { stream: true })); },
          flush(c) { c.enqueue(decoder.decode()); },
        });
      }
    }
    (g as any).TextDecoderStream = CarbonTextDecoderStream;
  }
  if (typeof (g as any).TextEncoderStream === "undefined") {
    class CarbonTextEncoderStream extends CarbonTransformStream<string, Uint8Array> {
      constructor() {
        const encoder = new (g as any).TextEncoder();
        super({
          transform(chunk, c) { c.enqueue(encoder.encode(chunk)); },
        });
      }
    }
    (g as any).TextEncoderStream = CarbonTextEncoderStream;
  }
}
