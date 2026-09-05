// @carbon/plugins/carbon-manifest — reads the app's own carbon.toml at
// runtime. Not an OS or hosted-cloud capability — see the carbon-manifest
// plugin's own main.zig header comment for what's deliberately excluded
// ([dev-signing] trusted_keys, each plugin's free-form config).
//
// import { useCarbonManifest } from "@carbon/plugins/carbon-manifest";
// const { readManifest } = useCarbonManifest();
// const m = readManifest()!;
// m.capabilities.netFetch // string[]

import { useCallback } from "react";
import { readManifest as rawReadManifest } from "carbon:carbon-manifest";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface ManifestWindow {
  title: string | null;
  width: number;
  height: number;
  resizable: boolean;
  decorations: boolean;
}

export interface ManifestInfo {
  app: {
    name: string;
    version: string;
    displayName: string | null;
    window: ManifestWindow;
  };
  runtime: {
    backend: string;
    bytecode: boolean;
    image: boolean;
    audio: boolean;
  };
  capabilities: {
    fsRead: string[];
    fsWrite: string[];
    netFetch: string[];
    systemNotify: boolean;
    imageRead: string[];
  };
  plugins: Record<string, { capabilities: string[] }>;
}

export interface UseCarbonManifestResult {
  readManifest: () => ManifestInfo | null;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("readManifest");
}

export function useCarbonManifest(): UseCarbonManifestResult {
  const readManifest = useCallback((): ManifestInfo | null => (pluginReady() ? rawReadManifest() : null), []);

  return { readManifest, ready: pluginReady() };
}
