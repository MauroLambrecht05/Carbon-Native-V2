// theme.tsx — Notion-inspired palette + provider.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

export interface ThemeColors {
  /** Page background. */
  bg: string;
  /** Sidebar / surface above bg. */
  sidebar: string;
  /** Subtle alt — chips, code, hover. */
  surfaceAlt: string;
  /** Hover background for sidebar items + buttons. */
  hover: string;
  /** Slightly stronger hover for selected items. */
  selected: string;
  /** 1 px hairline borders. */
  border: string;
  /** Stronger border for divider lines. */
  divider: string;

  /** Body text — Notion's soft black. */
  text: string;
  /** Secondary / metadata. */
  textMuted: string;
  /** Tertiary / placeholder labels. */
  textFaint: string;

  /** Accent — selected note background, primary buttons. */
  accent: string;
  /** Tinted background for accent surfaces. */
  accentSoft: string;
  /** Text on accent backgrounds. */
  accentText: string;

  danger: string;

  /** Decorative block colors used for note "icons". */
  iconColors: string[];
}

const LIGHT: ThemeColors = {
  bg: "#ffffff",
  sidebar: "#fbfaf8",
  surfaceAlt: "#f1f0ee",
  hover: "#efeeec",
  selected: "#e8e7e4",
  border: "#ecebe9",
  divider: "#e0dfdc",
  text: "#37352f",
  textMuted: "#787671",
  textFaint: "#9b9a96",
  accent: "#2383e2",
  accentSoft: "#e7f3fb",
  accentText: "#ffffff",
  danger: "#d44c47",
  iconColors: ["#e8a87c", "#85c1a3", "#a487d3", "#e6b450", "#5fa8d3", "#d57bb5"],
};

const DARK: ThemeColors = {
  bg: "#191919",
  sidebar: "#202020",
  surfaceAlt: "#2a2a2a",
  hover: "#2f2f2f",
  selected: "#373737",
  border: "#2f2f2f",
  divider: "#373737",
  text: "#e6e6e5",
  textMuted: "#9b9a96",
  textFaint: "#6f6f6c",
  accent: "#5c95e2",
  accentSoft: "#1d3a55",
  accentText: "#ffffff",
  danger: "#e87168",
  iconColors: ["#bb6b48", "#5e9978", "#8761b3", "#b58a30", "#3d7fae", "#a5588f"],
};

export interface ThemeContextValue {
  name: "light" | "dark";
  colors: ThemeColors;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<"light" | "dark">("light");
  const toggle = useCallback(() => setName((n) => (n === "light" ? "dark" : "light")), []);
  const value = useMemo<ThemeContextValue>(
    () => ({ name, colors: name === "light" ? LIGHT : DARK, toggle }),
    [name, toggle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used inside <ThemeProvider>");
  return v;
}

/** Pick a stable icon-block color from the palette based on a string key. */
export function pickIconColor(palette: string[], key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
