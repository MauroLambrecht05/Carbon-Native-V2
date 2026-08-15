// theme.tsx — chat-app palette inspired by Discord's dark/light themes.
// Colors are widely-used neutral grays + a blurple accent; nothing here
// is brand-locked. The palette is named per its USE (sidebar, hover,
// online-status) so component code stays semantic.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

export interface ChatColors {
  // Bg layers, outside in.
  serverRailBg: string;
  sidebarBg: string;
  mainBg: string;
  memberListBg: string;
  composerBg: string;

  // Surfaces
  surfaceHover: string;
  surfaceActive: string;
  surfaceElevated: string;
  surfaceSubtle: string;

  // Borders / dividers
  divider: string;
  separator: string;

  // Text
  text: string;
  textBright: string;
  textMuted: string;
  textFaint: string;
  textLink: string;

  // Accent (blurple-ish, original tone)
  accent: string;
  accentHover: string;
  accentText: string;

  // Status
  online: string;
  idle: string;
  dnd: string;
  offline: string;
  streaming: string;

  // Mention
  mentionBg: string;
  mentionBar: string;
}

const DARK: ChatColors = {
  serverRailBg: "#1e1f22",
  sidebarBg: "#2b2d31",
  mainBg: "#313338",
  memberListBg: "#2b2d31",
  composerBg: "#383a40",

  surfaceHover: "#35373c",
  surfaceActive: "#404249",
  surfaceElevated: "#232428",
  surfaceSubtle: "#2b2d31",

  divider: "#3f4147",
  separator: "#1f2023",

  text: "#dbdee1",
  textBright: "#f2f3f5",
  textMuted: "#b5bac1",
  textFaint: "#80848e",
  textLink: "#00a8fc",

  accent: "#5865f2",
  accentHover: "#4752c4",
  accentText: "#ffffff",

  online: "#23a559",
  idle: "#f0b232",
  dnd: "#f23f43",
  offline: "#80848e",
  streaming: "#593695",

  mentionBg: "rgba(88, 101, 242, 0.18)",
  mentionBar: "#5865f2",
};

const LIGHT: ChatColors = {
  serverRailBg: "#e3e5e8",
  sidebarBg: "#f2f3f5",
  mainBg: "#ffffff",
  memberListBg: "#f2f3f5",
  composerBg: "#ebedef",

  surfaceHover: "#dbdee1",
  surfaceActive: "#cfd0d3",
  surfaceElevated: "#e3e5e8",
  surfaceSubtle: "#ebedef",

  divider: "#e1e2e6",
  separator: "#d4d7dc",

  text: "#2e3338",
  textBright: "#060607",
  textMuted: "#4e5058",
  textFaint: "#5c5e66",
  textLink: "#0068e0",

  accent: "#5865f2",
  accentHover: "#4752c4",
  accentText: "#ffffff",

  online: "#23a559",
  idle: "#cd924e",
  dnd: "#d8453d",
  offline: "#80848e",
  streaming: "#593695",

  mentionBg: "rgba(88, 101, 242, 0.15)",
  mentionBar: "#5865f2",
};

export interface ThemeContextValue {
  name: "light" | "dark";
  colors: ChatColors;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState<"light" | "dark">("dark");
  const toggle = useCallback(
    () => setName((n) => (n === "light" ? "dark" : "light")),
    [],
  );
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

/** Hash a string to a stable HSL color for username text — saturated
 *  mid-tones, never too dark or washed-out. */
export function userColor(seed: string, isDark: boolean): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return isDark ? `hsl(${hue}, 60%, 65%)` : `hsl(${hue}, 55%, 40%)`;
}

// Curated avatar palette — 16 hand-picked vibrant tones that look good as
// 32–40 px filled circles. Avoiding muddy mid-tones / desaturated grays
// that the bare HSL hash kept producing. `avatarColor` is what the
// Avatar component uses for its background; userColor (above) stays for
// the username TEXT, where saturation needs to be lower for legibility.
const AVATAR_PALETTE = [
  "#5865f2", // blurple
  "#ed4245", // red
  "#eb459e", // pink
  "#a460f5", // purple
  "#5dade2", // sky
  "#23a559", // green
  "#f0b232", // gold
  "#fd7e14", // orange
  "#1abc9c", // teal
  "#9b59b6", // amethyst
  "#48c774", // emerald
  "#f47b67", // coral
  "#3498db", // azure
  "#e67e22", // tangerine
  "#16a085", // jade
  "#ff66c4", // magenta
];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}
