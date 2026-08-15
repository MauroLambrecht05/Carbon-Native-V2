// CanvasRenderingContext2D + OffscreenCanvas + ImageData — the JS half of
// carbon-mini's native 2D canvas. Backed by the runtime's canvas2d.rs via
// the __cm_canvas2d_* host imports. Lets unmodified npm packages that draw
// to a 2D <canvas> (xterm.js's canvas renderer + char measurement +
// color parsing, chart libraries, off-screen glyph atlases, …) run with
// NO per-package shim.
//
// Draw calls are batched into a small command list and flushed to the
// runtime on a microtask (one host call per burst). Synchronous reads
// (measureText, getImageData) flush first when they depend on prior
// draws, then call their own sync host import.

declare const __cm_canvas2d_create: (id: number, w: number, h: number) => void;
declare const __cm_canvas2d_resize: (id: number, w: number, h: number) => void;
declare const __cm_canvas2d_destroy: (id: number) => void;
declare const __cm_canvas2d_flush: (id: number, json: string) => void;
declare const __cm_canvas2d_measure_text: (text: string, px: number, mono: boolean) => number;
declare const __cm_canvas2d_get_pixels: (id: number, x: number, y: number, w: number, h: number) => string;
declare const __cm_canvas2d_put_pixels: (id: number, b64: string, sw: number, sh: number, dx: number, dy: number, dirty: string) => void;
declare const __cm_set_prop: (id: number, key: string, valueJson: string) => void;
declare const __cm_request_paint: () => void;
declare const __cm_load_system_font: ((chain: string, preferMono: boolean) => string) | undefined;

// Resolve a CSS font-family chain to a system font and load it into the
// runtime (fontdue) once. Lets terminals/editors that ask for a system or
// Nerd font (icons, box-drawing, real monospace) get the right glyphs with
// no bundled font. Shared by the canvas `font` setter and the DOM style
// proxy (node.ts), so the font is loaded as soon as it's first requested —
// before xterm measures cell size.
const _requestedFontChains = new Set<string>();
export function ensureSystemFont(chain: string, preferMono?: boolean): void {
  if (!chain || _requestedFontChains.has(chain)) return;
  _requestedFontChains.add(chain);
  const mono = preferMono ?? /mono|consol|cascad|courier|menlo|nerd|code/i.test(chain);
  try {
    if (typeof __cm_load_system_font === "function") __cm_load_system_font(chain, mono);
  } catch { /* ignore */ }
}

/** Extract the family list from a CSS font shorthand (drops style/weight/size). */
function familyChain(font: string): string {
  // The family list is everything after the size token.
  const m = /\d+(?:\.\d+)?(?:px|pt|em|rem)\s*(?:\/\s*[^ ]+)?\s+(.*)$/.exec(font);
  return m ? m[1].trim() : font.trim();
}

function nextSurfaceId(): number {
  const g = globalThis as { __cm_node_id_seq?: number };
  const next = (typeof g.__cm_node_id_seq === "number" ? g.__cm_node_id_seq : 99) + 1;
  g.__cm_node_id_seq = next;
  return next;
}

// ── font parsing ──────────────────────────────────────────────────────────
const MONO_RE = /mono|courier|consolas|menlo|jetbrains|fira code|source code|ubuntu mono|cascadia|hack|monaco/i;

function parseFont(font: string): { px: number; mono: boolean } {
  // CSS font shorthand: [style] [variant] [weight] <size>[/line-height] family
  let px = 10;
  const m = /(\d+(?:\.\d+)?)(px|pt|em|rem)/.exec(font);
  if (m) {
    const v = parseFloat(m[1]);
    const unit = m[2];
    px = unit === "pt" ? v * (96 / 72) : unit === "em" || unit === "rem" ? v * 16 : v;
  }
  return { px, mono: MONO_RE.test(font) };
}

// ── base64 (decode for getImageData) ───────────────────────────────────────
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function base64ToBytes(b64: string): Uint8Array {
  let len = b64.length;
  if (len === 0) return new Uint8Array(0);
  let pad = 0;
  if (b64[len - 1] === "=") pad++;
  if (b64[len - 2] === "=") pad++;
  const out = new Uint8Array((len * 3) / 4 - pad);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[b64.charCodeAt(i)];
    const b = B64_LOOKUP[b64.charCodeAt(i + 1)];
    const c = B64_LOOKUP[b64.charCodeAt(i + 2)];
    const d = B64_LOOKUP[b64.charCodeAt(i + 3)];
    out[o++] = (a << 2) | (b >> 4);
    if (o < out.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (o < out.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i];
    const b = i + 1 < len ? bytes[i + 1] : 0;
    const c = i + 2 < len ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < len ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < len ? B64[c & 63] : "=";
  }
  return out;
}

// ── ImageData ───────────────────────────────────────────────────────────────
export class CarbonImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  readonly colorSpace = "srgb";
  constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c ?? (a.length / 4 / b) | 0;
    }
  }
}

// ── CanvasGradient ───────────────────────────────────────────────────────────
export class CarbonCanvasGradient {
  _linear: boolean;
  _coords: number[];
  _stops: Array<[number, string]> = [];
  constructor(linear: boolean, coords: number[]) {
    this._linear = linear;
    this._coords = coords;
  }
  addColorStop(offset: number, color: string): void {
    this._stops.push([offset, color]);
  }
}

const ALIGN: Record<string, number> = { left: 0, start: 0, center: 1, right: 2, end: 2 };
const BASELINE: Record<string, number> = {
  alphabetic: 0, top: 1, middle: 2, bottom: 3, hanging: 4, ideographic: 3,
};
const CAP: Record<string, number> = { butt: 0, round: 1, square: 2 };
const JOIN: Record<string, number> = { miter: 0, round: 1, bevel: 2 };

// ── CanvasRenderingContext2D ─────────────────────────────────────────────────
export class CarbonCanvasContext2D {
  readonly canvas: any;
  private _id: number;
  private _cmds: any[] = [];
  private _scheduled = false;

  // Mirrored public state (so reads return what was set).
  private _fill: string | CarbonCanvasGradient = "#000000";
  private _stroke: string | CarbonCanvasGradient = "#000000";
  private _font = "10px sans-serif";
  private _lineWidth = 1;
  private _lineCap = "butt";
  private _lineJoin = "miter";
  private _lineDashOffset = 0;
  private _globalAlpha = 1;
  private _gco = "source-over";
  private _textAlign = "start";
  private _textBaseline = "alphabetic";
  private _dash: number[] = [];

  // No-op-ish state libraries read back.
  miterLimit = 10;
  shadowBlur = 0;
  shadowColor = "rgba(0,0,0,0)";
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  direction = "ltr";
  filter = "none";

  constructor(canvas: any, surfaceId: number) {
    this.canvas = canvas;
    this._id = surfaceId;
  }

  private push(cmd: any[]): void {
    this._cmds.push(cmd);
    if (!this._scheduled) {
      this._scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  flush(): void {
    this._scheduled = false;
    if (this._cmds.length === 0) return;
    const json = JSON.stringify(this._cmds);
    this._cmds.length = 0;
    try { __cm_canvas2d_flush(this._id, json); } catch { /* ignore */ }
  }

  // ── style properties ──────────────────────────────────────────────────────
  get fillStyle(): string | CarbonCanvasGradient { return this._fill; }
  set fillStyle(v: string | CarbonCanvasGradient) {
    this._fill = v;
    if (v instanceof CarbonCanvasGradient) this.push(this.gradOp("fsg", v));
    else this.push(["fs", String(v)]);
  }
  get strokeStyle(): string | CarbonCanvasGradient { return this._stroke; }
  set strokeStyle(v: string | CarbonCanvasGradient) {
    this._stroke = v;
    if (v instanceof CarbonCanvasGradient) this.push(this.gradOp("ssg", v));
    else this.push(["ss", String(v)]);
  }
  private gradOp(op: string, g: CarbonCanvasGradient): any[] {
    return [op, g._linear, g._coords, g._stops];
  }
  get font(): string { return this._font; }
  set font(v: string) {
    this._font = v;
    const { px, mono } = parseFont(v);
    ensureSystemFont(familyChain(v), mono);
    this.push(["fo", px, mono]);
  }
  get lineWidth(): number { return this._lineWidth; }
  set lineWidth(v: number) { this._lineWidth = v; this.push(["lw", v]); }
  get lineCap(): string { return this._lineCap; }
  set lineCap(v: string) { this._lineCap = v; this.push(["lc", CAP[v] ?? 0]); }
  get lineJoin(): string { return this._lineJoin; }
  set lineJoin(v: string) { this._lineJoin = v; this.push(["lj", JOIN[v] ?? 0]); }
  get lineDashOffset(): number { return this._lineDashOffset; }
  set lineDashOffset(v: number) { this._lineDashOffset = v; this.push(["ldo", v]); }
  get globalAlpha(): number { return this._globalAlpha; }
  set globalAlpha(v: number) { this._globalAlpha = v; this.push(["ga", v]); }
  get globalCompositeOperation(): string { return this._gco; }
  set globalCompositeOperation(v: string) { this._gco = v; this.push(["gco", v]); }
  get textAlign(): string { return this._textAlign; }
  set textAlign(v: string) { this._textAlign = v; this.push(["ta", ALIGN[v] ?? 0]); }
  get textBaseline(): string { return this._textBaseline; }
  set textBaseline(v: string) { this._textBaseline = v; this.push(["tb", BASELINE[v] ?? 0]); }

  setLineDash(arr: number[]): void { this._dash = arr.slice(); this.push(["ld", this._dash]); }
  getLineDash(): number[] { return this._dash.slice(); }

  // ── state ───────────────────────────────────────────────────────────────
  save(): void { this.push(["sv"]); }
  restore(): void { this.push(["rs"]); }
  scale(x: number, y: number): void { this.push(["sc", x, y]); }
  rotate(a: number): void { this.push(["ro", a]); }
  translate(x: number, y: number): void { this.push(["tr", x, y]); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.push(["tf", a, b, c, d, e, f]); }
  setTransform(a: any, b?: number, c?: number, d?: number, e?: number, f?: number): void {
    if (a && typeof a === "object") {
      this.push(["t", a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0]);
    } else {
      this.push(["t", a, b ?? 0, c ?? 0, d ?? 1, e ?? 0, f ?? 0]);
    }
  }
  resetTransform(): void { this.push(["rt"]); }
  getTransform(): any { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }

  // ── rects ─────────────────────────────────────────────────────────────────
  clearRect(x: number, y: number, w: number, h: number): void { this.push(["clr", x, y, w, h]); }
  fillRect(x: number, y: number, w: number, h: number): void { this.push(["fr", x, y, w, h]); }
  strokeRect(x: number, y: number, w: number, h: number): void { this.push(["sr", x, y, w, h]); }

  // ── paths ───────────────────────────────────────────────────────────────
  beginPath(): void { this.push(["bp"]); }
  closePath(): void { this.push(["cp"]); }
  moveTo(x: number, y: number): void { this.push(["mt", x, y]); }
  lineTo(x: number, y: number): void { this.push(["lt", x, y]); }
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void { this.push(["bc", a, b, c, d, e, f]); }
  quadraticCurveTo(a: number, b: number, c: number, d: number): void { this.push(["qc", a, b, c, d]); }
  arc(x: number, y: number, r: number, sa: number, ea: number, ccw?: boolean): void { this.push(["ar", x, y, r, sa, ea, !!ccw]); }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, sa: number, ea: number, ccw?: boolean): void { this.push(["ae", x, y, rx, ry, rot, sa, ea, !!ccw]); }
  rect(x: number, y: number, w: number, h: number): void { this.push(["re", x, y, w, h]); }
  roundRect(x: number, y: number, w: number, h: number, _r?: any): void { this.push(["re", x, y, w, h]); }
  arcTo(x1: number, y1: number, x2: number, _y2: number, _r: number): void { this.push(["lt", x1, y1]); this.push(["lt", x2, _y2]); }
  fill(rule?: string): void { this.push(["fl", rule ?? "nonzero"]); }
  stroke(): void { this.push(["sk"]); }
  clip(rule?: string): void { this.push(["cl", rule ?? "nonzero"]); }
  isPointInPath(): boolean { return false; }
  isPointInStroke(): boolean { return false; }

  // ── text ────────────────────────────────────────────────────────────────
  fillText(text: string, x: number, y: number, _maxWidth?: number): void { this.push(["ft", String(text), x, y]); }
  strokeText(text: string, x: number, y: number, _maxWidth?: number): void { this.push(["st", String(text), x, y]); }
  measureText(text: string): any {
    const { px, mono } = parseFont(this._font);
    let width = 0;
    try { width = __cm_canvas2d_measure_text(String(text), px, mono); } catch { width = String(text).length * px * 0.6; }
    const ascent = px * 0.8;
    const descent = px * 0.2;
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: ascent,
      actualBoundingBoxDescent: descent,
      fontBoundingBoxAscent: ascent,
      fontBoundingBoxDescent: descent,
      emHeightAscent: ascent,
      emHeightDescent: descent,
      hangingBaseline: ascent,
      alphabeticBaseline: 0,
      ideographicBaseline: -descent,
    };
  }

  // ── images ──────────────────────────────────────────────────────────────
  drawImage(img: any, ...args: number[]): void {
    const srcId = img?.__cmSurfaceId ?? img?.cmId;
    if (typeof srcId !== "number") return;
    this.push(["di", srcId, ...args]);
  }

  // ── pixels ──────────────────────────────────────────────────────────────
  createImageData(w: any, h?: number): CarbonImageData {
    if (w instanceof CarbonImageData) return new CarbonImageData(w.width, w.height);
    return new CarbonImageData(w, h ?? 0);
  }
  getImageData(x: number, y: number, w: number, h: number): CarbonImageData {
    this.flush(); // ensure prior draws have landed
    let bytes: Uint8Array;
    try {
      const b64 = __cm_canvas2d_get_pixels(this._id, x, y, w, h);
      bytes = base64ToBytes(b64);
    } catch {
      bytes = new Uint8Array(w * h * 4);
    }
    const data = new Uint8ClampedArray(w * h * 4);
    data.set(bytes.subarray(0, data.length));
    return new CarbonImageData(data, w, h);
  }
  putImageData(img: CarbonImageData, dx: number, dy: number, dirtyX?: number, dirtyY?: number, dirtyW?: number, dirtyH?: number): void {
    this.flush();
    const dX = dirtyX ?? 0;
    const dY = dirtyY ?? 0;
    const dW = dirtyW ?? img.width;
    const dH = dirtyH ?? img.height;
    try {
      const b64 = bytesToBase64(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
      __cm_canvas2d_put_pixels(this._id, b64, img.width, img.height, dx, dy, `${dX},${dY},${dW},${dH}`);
    } catch { /* ignore */ }
  }

  // ── gradients / patterns ──────────────────────────────────────────────────
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CarbonCanvasGradient {
    return new CarbonCanvasGradient(true, [x0, y0, x1, y1, 0, 0]);
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CarbonCanvasGradient {
    return new CarbonCanvasGradient(false, [x0, y0, r0, x1, y1, r1]);
  }
  createPattern(): null { return null; }

  // misc no-ops libraries call
  setLineWidth(w: number): void { this.lineWidth = w; }
  getContextAttributes(): any { return { alpha: true, desynchronized: false, colorSpace: "srgb", willReadFrequently: false }; }
}

// ── shared canvas behaviour (mixed into the canvas element + OffscreenCanvas) ─
export function makeCanvasBacking(surfaceId: number, initialW: number, initialH: number) {
  let w = initialW;
  let h = initialH;
  let ctx: CarbonCanvasContext2D | null = null;
  __cm_canvas2d_create(surfaceId, w, h);
  return {
    get width() { return w; },
    set width(v: number) { w = v | 0; __cm_canvas2d_resize(surfaceId, w, h); },
    get height() { return h; },
    set height(v: number) { h = v | 0; __cm_canvas2d_resize(surfaceId, w, h); },
    getCtx(host: any, type: string): any {
      if (type === "2d") {
        if (!ctx) ctx = new CarbonCanvasContext2D(host, surfaceId);
        return ctx;
      }
      // WebGL / WebGPU / bitmaprenderer are not provided — returning null
      // makes feature-detecting packages (e.g. xterm's WebglAddon) fall
      // back to their non-GPU path (the DOM / canvas-2d renderer).
      return null;
    },
    surfaceId,
  };
}

/** Augment a `<canvas>` CarbonElement with HTMLCanvasElement behaviour:
 *  width/height (backing resolution + intrinsic layout size), getContext,
 *  toDataURL/toBlob. The backing surface is created lazily on the first
 *  getContext so canvas elements that never draw cost nothing. */
export function attachCanvas(el: any): void {
  el.__cmSurfaceId = el.cmId;
  let backing: ReturnType<typeof makeCanvasBacking> | null = null;
  let pendingW = 300;
  let pendingH = 150;
  const setIntrinsic = (key: "width" | "height", v: number) => {
    try { __cm_set_prop(el.cmId, key, JSON.stringify(v)); __cm_request_paint(); } catch { /* ignore */ }
  };
  Object.defineProperty(el, "width", {
    configurable: true,
    enumerable: true,
    get() { return backing ? backing.width : pendingW; },
    set(v: number) {
      pendingW = Math.max(1, v | 0);
      if (backing) backing.width = pendingW;
      setIntrinsic("width", pendingW);
    },
  });
  Object.defineProperty(el, "height", {
    configurable: true,
    enumerable: true,
    get() { return backing ? backing.height : pendingH; },
    set(v: number) {
      pendingH = Math.max(1, v | 0);
      if (backing) backing.height = pendingH;
      setIntrinsic("height", pendingH);
    },
  });
  el.getContext = (type: string, _opts?: any): any => {
    if (!backing) backing = makeCanvasBacking(el.cmId, pendingW, pendingH);
    return backing.getCtx(el, type);
  };
  el.toDataURL = (): string => "data:,";
  el.toBlob = (cb: any): void => { if (typeof cb === "function") cb(null); };
  el.transferControlToOffscreen = (): CarbonOffscreenCanvas => new CarbonOffscreenCanvas(pendingW, pendingH);
}

// OffscreenCanvas — a backing store with no scene node (never displayed).
export class CarbonOffscreenCanvas {
  __cmSurfaceId: number;
  private _b: ReturnType<typeof makeCanvasBacking>;
  constructor(width = 300, height = 150) {
    this.__cmSurfaceId = nextSurfaceId();
    this._b = makeCanvasBacking(this.__cmSurfaceId, width, height);
  }
  get width(): number { return this._b.width; }
  set width(v: number) { this._b.width = v; }
  get height(): number { return this._b.height; }
  set height(v: number) { this._b.height = v; }
  getContext(type: string): any { return this._b.getCtx(this, type); }
  transferToImageBitmap(): any { return this; }
  convertToBlob(): Promise<any> { return Promise.resolve(null); }
}
