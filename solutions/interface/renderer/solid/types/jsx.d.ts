// Carbon-mini's JSX intrinsic elements + prop schemas, exposed as the
// GLOBAL JSX namespace so projects can use `<view>...</view>` with
// `tsconfig.json` set to `"jsx": "preserve"` (no `jsxImportSource`).
//
// Reference this file from your project's tsconfig:
//   { "compilerOptions": { "types": ["@carbon/mini-solid/types"] } }
//
// We do NOT augment solid-js's JSX namespace here because that pulls in
// browser DOM types (Element, Node, csstype) which carbon-mini doesn't
// have — and it forces tsconfig to use `jsxImportSource: "solid-js"`,
// which then makes TS look up `solid-js/jsx-runtime` for type-checking.
// Going global side-steps both problems.
//
// Style props accept BOTH kebab-case (`flex-direction`) and camelCase
// (`flexDirection`) — the runtime normalizes both. React projects almost
// always use camelCase, Solid projects almost always use kebab; the
// types accept either so neither side gets red squiggles.

declare global {
  namespace JSX {
    /** A rendered carbon-mini element. Loose `unknown` so JSX
     *  expressions can be reactive (functions, signals) without TS
     *  fighting the universal-renderer's runtime shape. */
    type Element = unknown;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {
      view: ViewProps;
      text: TextProps;
      button: ButtonProps;
      canvas: CanvasProps;
      // Form controls — implemented in carbon/runtime/engine/layout/src/scene.rs as
      // NodeKind::Input / NodeKind::Textarea. Single-line + multi-line
      // text editors with caret, selection, clipboard, undo/redo.
      input: InputElementProps;
      textarea: TextareaElementProps;
      // SVG primitives — painted by carbon/runtime/engine/paint/src/svg.rs from a
      // viewBox-driven coord space. Lucide-react and friends emit these
      // tags directly; the runtime never needs a DOM-shim layer for them.
      svg: SvgProps;
      path: SvgPathProps;
      line: SvgLineProps;
      circle: SvgCircleProps;
      rect: SvgRectProps;
      polyline: SvgPolyProps;
      polygon: SvgPolyProps;
    }
  }
}

// ─── Style schema ─────────────────────────────────────────────────────────
// What our paint pipeline understands today. Anything not in this list will
// land at the runtime as a generic prop and be silently ignored at paint.

type Length = number | string;

export interface CarbonStyle {
  // ─── Layout ────────────────────────────────────────────────────────────
  width?: Length;
  height?: Length;
  minWidth?: Length;
  "min-width"?: Length;
  minHeight?: Length;
  "min-height"?: Length;
  maxWidth?: Length;
  "max-width"?: Length;
  maxHeight?: Length;
  "max-height"?: Length;

  padding?: number;
  paddingTop?: number;
  "padding-top"?: number;
  paddingRight?: number;
  "padding-right"?: number;
  paddingBottom?: number;
  "padding-bottom"?: number;
  paddingLeft?: number;
  "padding-left"?: number;
  paddingX?: number;
  "padding-x"?: number;
  paddingY?: number;
  "padding-y"?: number;

  margin?: number;
  marginTop?: number;
  "margin-top"?: number;
  marginRight?: number;
  "margin-right"?: number;
  marginBottom?: number;
  "margin-bottom"?: number;
  marginLeft?: number;
  "margin-left"?: number;

  gap?: number;
  overflowY?: "visible" | "hidden" | "scroll" | "auto";
  "overflow-y"?: "visible" | "hidden" | "scroll" | "auto";

  // ─── Flex ──────────────────────────────────────────────────────────────
  display?: "flex" | "none";
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  "flex-direction"?: "row" | "column" | "row-reverse" | "column-reverse";
  flexWrap?: "nowrap" | "wrap" | "wrap-reverse";
  "flex-wrap"?: "nowrap" | "wrap" | "wrap-reverse";
  justifyContent?: "flex-start" | "flex-end" | "start" | "end" | "center" | "space-between" | "space-around" | "space-evenly";
  "justify-content"?: "flex-start" | "flex-end" | "start" | "end" | "center" | "space-between" | "space-around" | "space-evenly";
  alignItems?: "flex-start" | "flex-end" | "start" | "end" | "center" | "stretch" | "baseline";
  "align-items"?: "flex-start" | "flex-end" | "start" | "end" | "center" | "stretch" | "baseline";
  flexGrow?: number;
  "flex-grow"?: number;
  flexShrink?: number;
  "flex-shrink"?: number;
  flexBasis?: Length;
  "flex-basis"?: Length;

  // ─── Box ───────────────────────────────────────────────────────────────
  background?: string;
  backgroundHover?: string;
  "background-hover"?: string;
  backgroundImage?: string;
  "background-image"?: string;
  backgroundSize?: "cover" | "contain" | string;
  "background-size"?: "cover" | "contain" | string;
  borderRadius?: number;
  "border-radius"?: number;
  borderWidth?: number;
  "border-width"?: number;
  borderColor?: string;
  "border-color"?: string;
  opacity?: number;
  cursor?: "default" | "pointer" | "text" | "wait" | "crosshair" | "not-allowed" | "grab" | "grabbing" | string;

  // ─── Typography ────────────────────────────────────────────────────────
  // Apply to text/input/textarea nodes; inherited by descendants for fontSize.
  color?: string;
  colorHover?: string;
  "color-hover"?: string;
  fontSize?: number;
  "font-size"?: number;
  fontWeight?: number | "normal" | "bold";
  "font-weight"?: number | "normal" | "bold";
  textAlign?: "left" | "center" | "right";
  "text-align"?: "left" | "center" | "right";
}

// ─── Common event types ───────────────────────────────────────────────────
export interface ClickEvent {
  id: number;
}

/** Fired by `<input>` / `<textarea>` onChange handlers. Shape mirrors the
 *  React synthetic event shape (`e.target.value`) so the standard
 *  `onChange={(e) => setX(e.target.value)}` pattern type-checks unchanged. */
export interface InputChangeEvent {
  target: { value: string; name: string; id: string };
  currentTarget: { value: string; name: string; id: string };
  type: "change";
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
  persist(): void;
  nativeEvent: { value: string };
}

interface CommonProps {
  /** Inline style. Carbon parses this at build/runtime; not browser CSS. */
  style?: CarbonStyle;
  /** Tailwind utility classes. Compiled by @carbon/vite-plugin-tailwind at
   * build time into a precompiled style lookup; safe to use at runtime
   * but with no compile-time check today. */
  class?: string;
  className?: string;
  /** Mark a node clickable; receives a ClickEvent on press. */
  onClick?: (e: ClickEvent) => void;
  /** React-style key for list reconciliation. */
  key?: string | number;
  /** React/Solid imperative ref escape hatch. */
  ref?: any;
  children?: any;
}

export interface ViewProps extends CommonProps {}

export interface TextProps extends CommonProps {
  /** Text content can be passed via children for reactivity, OR as `text=""` for static. */
}

export interface ButtonProps extends CommonProps {
  disabled?: boolean;
}

// ─── Form controls ────────────────────────────────────────────────────────

interface InputCommonProps extends CommonProps {
  /** Controlled value. Updated via onChange; the runtime keeps caret /
   *  selection state across re-renders so React can drive the input
   *  with no jank. */
  value?: string;
  /** Faint placeholder text shown when value is empty. */
  placeholder?: string;
  /** Disable focus / typing. (Currently visual-only; key events ignored.) */
  disabled?: boolean;
  /** Fired on every edit (insert / backspace / delete / paste / undo).
   *  Both names accepted for React/Solid compatibility. */
  onChange?: (e: InputChangeEvent) => void;
  onInput?: (e: InputChangeEvent) => void;
}

/** Single-line text input. Wraps to one visual line; Enter is ignored. */
export interface InputElementProps extends InputCommonProps {
  type?: "text" | "search" | "email" | "password" | "url" | "tel";
  /** Maximum byte length. Not enforced today; reserved for future use. */
  maxLength?: number;
}

/** Multi-line text input. Soft-wraps to width, Enter inserts a newline,
 *  arrow-up/down navigates between visual lines. Box height auto-grows
 *  to content unless an explicit `height` is set in `style`. */
export interface TextareaElementProps extends InputCommonProps {
  /** Hint for initial line count. Currently ignored — the box auto-grows. */
  rows?: number;
  cols?: number;
}

// ─── SVG ──────────────────────────────────────────────────────────────────
//
// Supports the subset emitted by lucide-react / heroicons / etc.: <svg>
// with viewBox + the five primitive shapes. Stroke / fill cascade from
// parent <svg>; "currentColor" resolves to the inherited text color so
// icons inherit theme colors automatically.

interface SvgCommonProps extends CommonProps {
  width?: number | string;
  height?: number | string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number | string;
  "stroke-width"?: number | string;
  strokeLinecap?: "butt" | "round" | "square";
  "stroke-linecap"?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
  "stroke-linejoin"?: "miter" | "round" | "bevel";
  opacity?: number;
}

export interface SvgProps extends SvgCommonProps {
  /** "minX minY width height". Children render in this coord space. */
  viewBox?: string;
  xmlns?: string;
  /** SVG-spec accessibility — ignored at paint, accepted for consistency. */
  role?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export interface SvgPathProps extends SvgCommonProps {
  /** SVG path data. Supports M, L, H, V, C, S, Q, T, Z (plus lowercase
   *  relative variants). A subset of the full SVG spec — sufficient for
   *  every icon we've seen from the major React icon packs. */
  d: string;
}

export interface SvgLineProps extends SvgCommonProps {
  x1: number | string;
  y1: number | string;
  x2: number | string;
  y2: number | string;
}

export interface SvgCircleProps extends SvgCommonProps {
  cx: number | string;
  cy: number | string;
  r: number | string;
}

export interface SvgRectProps extends SvgCommonProps {
  x?: number | string;
  y?: number | string;
  width: number | string;
  height: number | string;
  rx?: number | string;
  ry?: number | string;
}

export interface SvgPolyProps extends SvgCommonProps {
  /** "x,y x,y x,y" or "x y x y x y" — the runtime accepts both. */
  points: string;
}

/** Phase 1 GPU-backed offscreen canvas. The Rust runtime creates a
 *  wgpu surface lazily on the first time both `width` and `height`
 *  are set, and tears it down when the element unmounts. Inside the
 *  scene tree the canvas lays out exactly like a fixed-size view of
 *  `width × height` device pixels.
 *
 *  Phase 1 imperative API (called via the host bindings declared in
 *  `@carbon/mini-solid/src/index.ts`):
 *    - __carbon_canvas_clear(id, r, g, b, a)
 *  Phase 2 will add real draw commands.
 */
export interface CanvasProps extends CommonProps {
  /** Canvas pixel width. */
  width: number;
  /** Canvas pixel height. */
  height: number;
  /** Called once when the wgpu surface is created. The id is what
   *  Phase 1 callers pass to `__carbon_canvas_clear` etc. */
  onReady?: (info: { id: number }) => void;
  /** Imperative escape hatch for callers that want the CmNode
   *  (which carries `canvasId`) directly. Solid invokes this with
   *  the renderer's node — the type is intentionally `any` so
   *  user code doesn't import internals. */
  ref?: (node: any) => void;
}
