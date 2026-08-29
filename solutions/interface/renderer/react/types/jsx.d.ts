// JSX intrinsic types for React-on-carbon-mini.
//
// React 18 looks for `React.JSX.IntrinsicElements`; React 19 looks for
// `JSX.IntrinsicElements` from the importSource. We declare both to cover
// either tsconfig.
//
// Style props use camelCase (React convention). Mirrors the prop shape of
// `carbon/runtime/engine/paint/renderers/solid/types/jsx.d.ts` for Solid; both are derived from
// what `carbon/runtime/engine/layout/src/scene.rs` actually understands at paint time.

import type { ReactNode } from "react";

// Augment csstype.Properties (the underlying type of React.CSSProperties)
// with the carbon-specific style props our paint pipeline understands but
// standard CSS doesn't have. Inlined here rather than in a separate file
// so it's loaded together with the JSX augmentation.
declare module "csstype" {
  interface Properties {
    /** Background paint when the cursor is hovered over this node. */
    backgroundHover?: string;
    /** Text color when hovered. Mostly used on clickable rows. */
    colorHover?: string;
    /** Symmetric horizontal padding (left + right). */
    paddingX?: number | string;
    /** Symmetric vertical padding (top + bottom). */
    paddingY?: number | string;
  }
}

// ─── Style schema ─────────────────────────────────────────────────────────
type Length = number | string;

export interface CarbonReactStyle {
  // ─── Layout ─────────────────────────────────────────────────────────────
  width?: Length;
  height?: Length;
  minWidth?: Length;
  minHeight?: Length;
  maxWidth?: Length;
  maxHeight?: Length;

  padding?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingX?: number;
  paddingY?: number;

  margin?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;

  gap?: number;
  overflowY?: "visible" | "hidden" | "scroll" | "auto";

  // ─── Flex ───────────────────────────────────────────────────────────────
  display?: "flex" | "none";
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  flexWrap?: "nowrap" | "wrap" | "wrap-reverse";
  justifyContent?:
    | "flex-start"
    | "flex-end"
    | "start"
    | "end"
    | "center"
    | "space-between"
    | "space-around"
    | "space-evenly";
  alignItems?:
    | "flex-start"
    | "flex-end"
    | "start"
    | "end"
    | "center"
    | "stretch"
    | "baseline";
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: Length;

  // ─── Box ────────────────────────────────────────────────────────────────
  background?: string;
  backgroundHover?: string;
  backgroundImage?: string;
  backgroundSize?: "cover" | "contain" | string;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: string;
  opacity?: number;
  cursor?:
    | "default"
    | "pointer"
    | "text"
    | "wait"
    | "crosshair"
    | "not-allowed"
    | "grab"
    | "grabbing"
    | string;

  // ─── Typography ─────────────────────────────────────────────────────────
  color?: string;
  colorHover?: string;
  fontSize?: number;
  fontWeight?: number | "normal" | "bold";
  textAlign?: "left" | "center" | "right";
}

// ─── Event types ──────────────────────────────────────────────────────────
export interface ClickEvent {
  id: number;
}

/** Fired by `<input>` / `<textarea>` onChange handlers. Shape mirrors the
 *  React synthetic event so `onChange={(e) => setX(e.target.value)}`
 *  type-checks unchanged. */
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

// ─── Common props ─────────────────────────────────────────────────────────
interface CarbonCommonProps {
  style?: CarbonReactStyle;
  class?: string;
  className?: string;
  onClick?: (e: ClickEvent) => void;
  children?: ReactNode;
  key?: string | number | null;
  ref?: any;
}

// ─── Element-specific props ───────────────────────────────────────────────
export interface ViewProps extends CarbonCommonProps {}
export interface TextProps extends CarbonCommonProps {}
export interface ButtonProps extends CarbonCommonProps {
  disabled?: boolean;
}
export interface CanvasProps extends CarbonCommonProps {
  width: number;
  height: number;
  onReady?: (info: { id: number }) => void;
}

interface InputCommonReactProps extends CarbonCommonProps {
  /** Controlled value. Updated through onChange; the runtime preserves
   *  caret + selection across re-renders so React can drive the input
   *  with no jank. */
  value?: string;
  /** Faint placeholder text shown when value is empty. */
  placeholder?: string;
  disabled?: boolean;
  /** Both names accepted; the runtime fires either one. */
  onChange?: (e: InputChangeEvent) => void;
  onInput?: (e: InputChangeEvent) => void;
}

/** Single-line text input. Soft-wraps to one visual line; Enter is ignored. */
export interface InputElementProps extends InputCommonReactProps {
  type?: "text" | "search" | "email" | "password" | "url" | "tel";
  maxLength?: number;
}

/** Multi-line text input. Soft-wraps to width, Enter inserts a newline,
 *  arrow-up/down navigates between visual lines. Box height auto-grows
 *  to content unless an explicit `height` is set. */
export interface TextareaElementProps extends InputCommonReactProps {
  rows?: number;
  cols?: number;
}

// ─── SVG ──────────────────────────────────────────────────────────────────
//
// The subset emitted by lucide-react / heroicons / etc. — <svg> with a
// viewBox plus the five primitive shapes. Stroke / fill cascade from the
// parent <svg>; "currentColor" resolves to the inherited text color.

interface SvgCommonReactProps extends CarbonCommonProps {
  width?: number | string;
  height?: number | string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number | string;
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
  opacity?: number;
}

export interface SvgProps extends SvgCommonReactProps {
  /** "minX minY width height". Children render in this coord space. */
  viewBox?: string;
  xmlns?: string;
  role?: string;
  "aria-hidden"?: boolean | "true" | "false";
  "aria-label"?: string;
}

export interface SvgPathProps extends SvgCommonReactProps {
  /** SVG path data. Supports M, L, H, V, C, S, Q, T, Z (plus lowercase
   *  relative variants) — sufficient for every icon we've seen from the
   *  major React icon packs. */
  d: string;
}

export interface SvgLineProps extends SvgCommonReactProps {
  x1: number | string;
  y1: number | string;
  x2: number | string;
  y2: number | string;
}

export interface SvgCircleProps extends SvgCommonReactProps {
  cx: number | string;
  cy: number | string;
  r: number | string;
}

export interface SvgRectProps extends SvgCommonReactProps {
  x?: number | string;
  y?: number | string;
  width: number | string;
  height: number | string;
  rx?: number | string;
  ry?: number | string;
}

export interface SvgPolyProps extends SvgCommonReactProps {
  /** "x,y x,y x,y" or "x y x y x y" — both accepted. */
  points: string;
}

// Every tag name carbon-mini's React renderer understands. `view` and `text`
// collide with real SVG elements (SVGViewElement, SVGTextElement) — and
// `input`/`textarea`/`svg`/`path`/`line`/`circle`/`rect`/`polyline`/`polygon`
// collide with HTML/SVG too. Declaration-merging a same-named property into
// React's own IntrinsicElements does NOT win against those — TypeScript
// keeps whichever declaration it saw first (silently, since skipLibCheck
// hides the "cannot simultaneously extend" error this would otherwise be),
// and empirically that is always React's, never this one. Verified directly:
// merging this into `declare global`/`declare module "react"` left `<view>`
// typed as `SVGProps<SVGViewElement>`, with no trace of ViewProps.
//
// So this interface is not merged into React's namespace at all. It is
// exported and consumed by ../runtime/jsx-runtime.ts, which re-exports it
// as that module's OWN `JSX` namespace — the module `jsxImportSource`
// points at. Automatic-runtime JSX resolution reads the IntrinsicElements
// of THAT module exclusively; it does not also merge in the global one, so
// there is no collision left to lose.
export interface CarbonReactIntrinsics {
  view: ViewProps;
  text: TextProps;
  button: ButtonProps;
  canvas: CanvasProps;
  input: InputElementProps;
  textarea: TextareaElementProps;
  svg: SvgProps;
  path: SvgPathProps;
  line: SvgLineProps;
  circle: SvgCircleProps;
  rect: SvgRectProps;
  polyline: SvgPolyProps;
  polygon: SvgPolyProps;
}
