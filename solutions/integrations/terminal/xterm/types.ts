// Subset of @xterm/xterm's public types that terax-ai (and the broad
// xterm ecosystem) actually exercise. Pulled inline so the shim doesn't
// take a peer-dep on @xterm/xterm itself — we ARE @xterm/xterm from
// the bundler's point of view, via the carbon alias config.

export interface ITheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface ITerminalOptions {
  cols?: number;
  rows?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  fontWeightBold?: number | string;
  lineHeight?: number;
  letterSpacing?: number;
  theme?: ITheme;
  cursorBlink?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
  cursorInactiveStyle?: "block" | "underline" | "bar" | "outline" | "none";
  cursorWidth?: number;
  scrollback?: number;
  tabStopWidth?: number;
  allowProposedApi?: boolean;
  allowTransparency?: boolean;
  convertEol?: boolean;
  disableStdin?: boolean;
  screenReaderMode?: boolean;
  /** Anything we don't model is accepted silently. */
  [key: string]: unknown;
}

export interface IDisposable {
  dispose(): void;
}

export interface IMarker extends IDisposable {
  readonly id: number;
  readonly line: number;
  readonly isDisposed: boolean;
}

export interface IBufferCell {
  getWidth(): 1 | 2;
  getChars(): string;
  getCode(): number;
  getFgColor(): number;
  getFgColorMode(): number;
  getBgColor(): number;
  getBgColorMode(): number;
  isBold(): boolean;
  isItalic(): boolean;
  isDim(): boolean;
  isInverse(): boolean;
  isInvisible(): boolean;
  isUnderline(): boolean;
  isBlink(): boolean;
  isStrikethrough(): boolean;
  isOverline(): boolean;
}

export interface IBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number, cell?: IBufferCell): IBufferCell | undefined;
  translateToString(trimRight?: boolean, startCol?: number, endCol?: number): string;
}

export interface IBuffer {
  readonly type: "normal" | "alternate";
  readonly cursorY: number;
  readonly cursorX: number;
  readonly viewportY: number;
  readonly baseY: number;
  readonly length: number;
  getLine(y: number): IBufferLine | undefined;
}

export interface IBufferNamespace {
  readonly active: IBuffer;
  readonly normal: IBuffer;
  readonly alternate: IBuffer;
  onBufferChange(cb: (buffer: IBuffer) => void): IDisposable;
}

export interface ITerminalAddon extends IDisposable {
  activate(terminal: ITerminal): void;
}

export interface ITerminal {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly buffer: IBufferNamespace;
  open(parent: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  writeln(data: string | Uint8Array, callback?: () => void): void;
  clear(): void;
  reset(): void;
  resize(columns: number, rows: number): void;
  focus(): void;
  blur(): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  selectAll(): void;
  scrollLines(amount: number): void;
  scrollPages(amount: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  scrollToLine(line: number): void;
  loadAddon(addon: ITerminalAddon): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void;
  onData(cb: (data: string) => void): IDisposable;
  onBinary(cb: (data: string) => void): IDisposable;
  onKey(cb: (e: { key: string; domEvent: KeyboardEvent }) => void): IDisposable;
  onResize(cb: (e: { cols: number; rows: number }) => void): IDisposable;
  onTitleChange(cb: (title: string) => void): IDisposable;
  onCursorMove(cb: () => void): IDisposable;
  onSelectionChange(cb: () => void): IDisposable;
  onWriteParsed(cb: () => void): IDisposable;
  onRender(cb: (e: { start: number; end: number }) => void): IDisposable;
  registerMarker(cursorYOffset?: number): IMarker;
  refresh(start: number, end: number): void;
  dispose(): void;
}
