// net — fetch / WebSocket / Headers / AbortController.
//
// Unlike every other binding in this package, nothing here calls a `__cm_*`
// function. The Rust runtime installs Web-compatible `fetch`, `Response`,
// `Headers`, `AbortController`, `AbortSignal` and `WebSocket` directly on
// `globalThis` at startup (see infrastructure/os `net/net_shim.js`). They
// follow the WHATWG / W3C contracts close enough that most ported web code
// Just Works:
//
//   const r = await fetch("https://api.example.com/x", { method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify({ hi: "world" }) });
//   const data = await r.json();
//
//   const ws = new WebSocket("wss://example.com/socket");
//   ws.onmessage = (e) => console.log(e.data);
//   ws.send("ping");
//
// Streaming bodies (SSE for LLM clients, chunked downloads):
//
//   const r = await fetch(url);
//   const reader = r.body.getReader();
//   while (true) {
//     const { done, value } = await reader.read();
//     if (done) break;
//     // value is a Uint8Array
//   }
//
// Cancellation:
//
//   const ctl = new AbortController();
//   fetch(url, { signal: ctl.signal });
//   ctl.abort();
//
// So this file's job is types: the ambient declarations below give an app the
// shapes without needing `"DOM"` in tsconfig `lib`. They mirror the subset of
// the spec we implement; FormData / Blob / URLSearchParams body types and CORS
// modes are not (yet) supported — string / Uint8Array / ArrayBuffer bodies are.

declare global {
  // Headers
  interface CarbonHeaders {
    append(name: string, value: string): void;
    delete(name: string): void;
    get(name: string): string | null;
    has(name: string): boolean;
    set(name: string, value: string): void;
    forEach(cb: (value: string, key: string, parent: CarbonHeaders) => void, thisArg?: unknown): void;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
    [Symbol.iterator](): IterableIterator<[string, string]>;
  }
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const Headers: { new (init?: Record<string, string> | [string, string][] | CarbonHeaders): CarbonHeaders };

  // AbortController / AbortSignal
  interface CarbonAbortSignal {
    readonly aborted: boolean;
    readonly reason: unknown;
    onabort: ((ev: { type: "abort"; target: CarbonAbortSignal }) => void) | null;
    addEventListener(type: "abort", cb: (ev: { type: "abort"; target: CarbonAbortSignal }) => void): void;
    removeEventListener(type: "abort", cb: (ev: { type: "abort"; target: CarbonAbortSignal }) => void): void;
    throwIfAborted(): void;
  }
  interface CarbonAbortController {
    readonly signal: CarbonAbortSignal;
    abort(reason?: unknown): void;
  }
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const AbortController: { new (): CarbonAbortController };
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const AbortSignal: { new (): CarbonAbortSignal };

  // Response
  interface CarbonResponseBody {
    getReader(): {
      read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  }
  interface CarbonResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly headers: CarbonHeaders;
    readonly url: string;
    readonly type: "basic";
    readonly redirected: boolean;
    readonly bodyUsed: boolean;
    readonly body: CarbonResponseBody;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
    arrayBuffer(): Promise<ArrayBuffer>;
    bytes(): Promise<Uint8Array>;
  }
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const Response: { new (...args: unknown[]): CarbonResponse };

  interface CarbonRequestInit {
    method?: string;
    headers?: CarbonHeaders | Record<string, string> | [string, string][];
    body?: string | Uint8Array | ArrayBuffer | ArrayBufferView | null;
    signal?: CarbonAbortSignal;
  }
  function fetch(input: string | { url: string }, init?: CarbonRequestInit): Promise<CarbonResponse>;

  // WebSocket
  interface CarbonWebSocketEvent { type: string; target: CarbonWebSocket }
  interface CarbonWebSocketMessageEvent extends CarbonWebSocketEvent {
    type: "message";
    data: string | ArrayBuffer | Uint8Array;
  }
  interface CarbonWebSocketCloseEvent extends CarbonWebSocketEvent {
    type: "close";
    code: number;
    reason: string;
    wasClean: boolean;
  }
  interface CarbonWebSocketErrorEvent extends CarbonWebSocketEvent {
    type: "error";
    message: string;
  }
  interface CarbonWebSocket {
    readonly url: string;
    readonly readyState: number; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    readonly bufferedAmount: number;
    binaryType: "arraybuffer" | "uint8array";
    onopen: ((ev: CarbonWebSocketEvent) => void) | null;
    onmessage: ((ev: CarbonWebSocketMessageEvent) => void) | null;
    onclose: ((ev: CarbonWebSocketCloseEvent) => void) | null;
    onerror: ((ev: CarbonWebSocketErrorEvent) => void) | null;
    addEventListener(type: "open", cb: (ev: CarbonWebSocketEvent) => void): void;
    addEventListener(type: "message", cb: (ev: CarbonWebSocketMessageEvent) => void): void;
    addEventListener(type: "close", cb: (ev: CarbonWebSocketCloseEvent) => void): void;
    addEventListener(type: "error", cb: (ev: CarbonWebSocketErrorEvent) => void): void;
    removeEventListener(type: string, cb: (...args: unknown[]) => void): void;
    send(data: string | Uint8Array | ArrayBuffer | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
  }
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const WebSocket: {
    new (url: string, protocols?: string | string[]): CarbonWebSocket;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
  };
}

// Optional named re-exports for IDE auto-import. These point at the
// runtime globals so you can write `import { fetch, WebSocket } from
// "@carbon/runtime-bindings"` if you prefer.
export const net = {
  // Cast through `unknown`. These four names are DECLARED in this file — the
  // runtime installs them via net_shim.js — so `typeof AbortController` here
  // means our declaration, and globalThis (lib ES2022, no DOM, no bun types)
  // has no member of that name to overlap with. Type-level only; the values
  // are whatever the runtime installed.
  fetch: (input: string | { url: string }, init?: CarbonRequestInit) =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch(input, init),
  WebSocket: (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket,
  Headers: (globalThis as unknown as { Headers: typeof Headers }).Headers,
  AbortController: (globalThis as unknown as { AbortController: typeof AbortController })
    .AbortController,
};
