// The starting stacks a new project can be scaffolded from.
//
// A preset is a dependency-and-config stack, not a template. It names the shape
// of the manifest and the styling approach; which bytes those correspond to is
// infrastructure's problem. That split is what lets a preset be validated,
// listed in help, and tested without any template strings being loaded.

import { UnknownPresetError } from "../errors/ScaffoldError.ts";

export type PresetName =
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
  /** One line, shown by `carbon init --list-presets`. */
  readonly summary: string;
  readonly manifest: ManifestShape;
  readonly styling: Styling;
}

/**
 * Ordered simplest-first, because that is the order help should list them in
 * and the order someone picking one should read them.
 */
export const PRESETS: readonly Preset[] = [
  {
    name: "blank",
    summary: "minimum: @carbon/mini-solid + solid-js (no plugins)",
    manifest: "base",
    styling: "inline",
  },
  {
    name: "blank-plugins",
    summary: "blank + @carbon/vite/transforms (console-stripping, etc.)",
    manifest: "base",
    styling: "inline",
  },
  {
    name: "tailwind",
    summary: 'blank + tailwind plugin (use class="..." in JSX)',
    manifest: "tailwind",
    styling: "tailwind",
  },
  {
    name: "tailwind-plugins",
    summary: "tailwind + @carbon/vite/transforms",
    manifest: "tailwind",
    styling: "tailwind",
  },
  {
    name: "three",
    summary: "tailwind + three.js + @carbon/three",
    manifest: "three",
    styling: "tailwind",
  },
];

export const DEFAULT_PRESET: PresetName = "blank";

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
