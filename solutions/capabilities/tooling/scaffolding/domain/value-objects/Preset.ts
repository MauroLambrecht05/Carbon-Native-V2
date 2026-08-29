// The starting stacks a new project can be scaffolded from.
//
// A preset is a dependency-and-config stack, not a template. It names the
// renderer, the manifest shape, and the styling approach; which bytes those
// correspond to is infrastructure's problem.
//
// Two renderers:
//   solid  — @carbon/mini-solid  (reactive signals, Solid-style JSX)
//   react  — @carbon/mini-react  (React 18, familiar hooks API)
//
// Three stacks per renderer:
//   blank           minimum — no Tailwind, no plugins
//   tailwind        adds the Tailwind class compiler
//   tailwind-plugins adds Tailwind + @carbon/vite/transforms (console-strip etc.)

import { UnknownPresetError } from "../errors/ScaffoldError.ts";

export type Renderer = "solid" | "react";

export type PresetName =
  | "solid-blank"
  | "solid-tailwind"
  | "solid-tailwind-plugins"
  | "react-blank"
  | "react-tailwind"
  | "react-tailwind-plugins"
  // Legacy names kept so existing scripts / CI don't break.
  | "blank"
  | "blank-plugins"
  | "tailwind"
  | "tailwind-plugins"
  | "three";

/** The carbon.toml shape a preset needs. */
export type ManifestShape = "base" | "tailwind" | "three";

/** How the generated App.tsx styles itself. */
export type Styling = "inline" | "tailwind";

export interface Preset {
  readonly name: PresetName;
  /** One line, shown in the interactive menu. */
  readonly summary: string;
  readonly renderer: Renderer;
  readonly manifest: ManifestShape;
  readonly styling: Styling;
}

/**
 * Ordered by renderer then complexity — this is the order the interactive
 * menu displays them, so simpler choices come first within each group.
 */
export const PRESETS: readonly Preset[] = [
  // ── Solid ──────────────────────────────────────────────────────────────
  {
    name: "solid-blank",
    summary: "Solid.js — signals, minimal setup",
    renderer: "solid",
    manifest: "base",
    styling: "inline",
  },
  {
    name: "solid-tailwind",
    summary: "Solid.js + Tailwind CSS",
    renderer: "solid",
    manifest: "tailwind",
    styling: "tailwind",
  },
  {
    name: "solid-tailwind-plugins",
    summary: "Solid.js + Tailwind + build transforms",
    renderer: "solid",
    manifest: "tailwind",
    styling: "tailwind",
  },
  // ── React ───────────────────────────────────────────────────────────────
  {
    name: "react-blank",
    summary: "React 18 — hooks, minimal setup",
    renderer: "react",
    manifest: "base",
    styling: "inline",
  },
  {
    name: "react-tailwind",
    summary: "React 18 + Tailwind CSS",
    renderer: "react",
    manifest: "tailwind",
    styling: "tailwind",
  },
  {
    name: "react-tailwind-plugins",
    summary: "React 18 + Tailwind + build transforms",
    renderer: "react",
    manifest: "tailwind",
    styling: "tailwind",
  },
  // ── Three.js (Solid) ────────────────────────────────────────────────────
  {
    name: "three",
    summary: "Solid.js + three.js + @carbon/three (3D canvas)",
    renderer: "solid",
    manifest: "three",
    styling: "tailwind",
  },
  // ── Legacy aliases (map straight to their equivalents above) ───────────
  {
    name: "blank",
    summary: "Solid.js — minimal (alias for solid-blank)",
    renderer: "solid",
    manifest: "base",
    styling: "inline",
  },
  {
    name: "blank-plugins",
    // No new-name equivalent: the new scheme only pairs "-plugins" with
    // Tailwind. This keeps V1's blank-plus-transforms-no-Tailwind shape.
    summary: "Solid.js + build transforms, no Tailwind (legacy)",
    renderer: "solid",
    manifest: "base",
    styling: "inline",
  },
  {
    name: "tailwind",
    summary: "Solid.js + Tailwind (alias for solid-tailwind)",
    renderer: "solid",
    manifest: "tailwind",
    styling: "tailwind",
  },
  {
    name: "tailwind-plugins",
    summary: "Solid.js + Tailwind + transforms (alias for solid-tailwind-plugins)",
    renderer: "solid",
    manifest: "tailwind",
    styling: "tailwind",
  },
];

/** The presets shown in the interactive menu (excludes legacy aliases). */
export const MENU_PRESETS: readonly Preset[] = PRESETS.filter(
  (p) => !["blank", "blank-plugins", "tailwind", "tailwind-plugins"].includes(p.name),
);

export const DEFAULT_PRESET: PresetName = "solid-blank";

export const PRESET_NAMES: readonly PresetName[] = PRESETS.map((p) => p.name);

/**
 * @throws UnknownPresetError — an unrecognised name used to fall through to
 * "blank" silently, so a typo scaffolded the wrong stack without saying so.
 */
export function presetNamed(name: string): Preset {
  const found = PRESETS.find((p) => p.name === name);
  if (!found) throw new UnknownPresetError(name, PRESET_NAMES);
  return found;
}
