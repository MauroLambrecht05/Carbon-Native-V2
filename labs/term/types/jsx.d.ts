// Augments solid-js's JSX namespace with carbon-term's Ink-compatible
// intrinsic elements + their prop schemas. Reference from your tsconfig:
//
//   { "compilerOptions": { "types": ["@carbon/term/types"] } }

import "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      Box: BoxProps;
      Text: TextProps;
      Newline: NewlineProps;
      Spacer: {};
      Static: BoxProps & { items?: any[] };
    }
  }
}

// Color names recognised by carbon-term. Hex (#rrggbb / #rgb) also works
// at runtime; the type below is best-effort autocomplete.
export type CarbonTermColor =
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "gray" | "grey" | "blackBright"
  | "redBright" | "greenBright" | "yellowBright"
  | "blueBright" | "magentaBright" | "cyanBright" | "whiteBright"
  | (string & {});

export type BorderStyle =
  | "single" | "double" | "round" | "bold"
  | "single-double" | "double-single" | "classic";

export type WrapMode =
  | "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end";

export interface BoxProps {
  children?: any;
  flexDirection?: "row" | "column" | "row-reverse" | "column-reverse";
  flexGrow?: number;
  flexShrink?: number;
  alignItems?: "flex-start" | "flex-end" | "center" | "stretch";
  justifyContent?: "flex-start" | "flex-end" | "center" | "space-between" | "space-around" | "space-evenly";
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  margin?: number;
  marginX?: number;
  marginY?: number;
  marginTop?: number;
  marginRight?: number;
  marginBottom?: number;
  marginLeft?: number;
  gap?: number;
  width?: number | string;
  height?: number | string;
  minWidth?: number;
  minHeight?: number;
  borderStyle?: BorderStyle;
  borderColor?: CarbonTermColor;
  backgroundColor?: CarbonTermColor;
}

export interface TextProps {
  children?: any;
  color?: CarbonTermColor;
  backgroundColor?: CarbonTermColor;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  dimColor?: boolean;
  wrap?: WrapMode;
}

export interface NewlineProps {
  count?: number;
}
