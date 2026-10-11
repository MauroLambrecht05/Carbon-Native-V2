import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HttpRegistrySource, NodePackageCache, NodePluginProject, RegistryPlugins, type PluginHost } from "@carbon/catalog";
import type { RegistryTarget } from "@carbon/contracts/platform";
import { PRODUCTS_DIR } from "@carbon/workspace";

const TARGETS: Record<string, RegistryTarget> = {
  "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu", "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin",
};

/** The plugin ABI this toolchain builds apps against, read from the SDK header that defines it. */
export function hostPluginAbi(header: string = join(PRODUCTS_DIR, "carbon-ext", "presentation", "include", "carbon_plugin.h")): { abiMajor: number; abiMinor: number } {
  const text = readFileSync(header, "utf8");
  const major = /^#define CARBON_PLUGIN_ABI_VERSION_MAJOR (\d+)u?$/m.exec(text); const minor = /^#define CARBON_PLUGIN_ABI_VERSION_MINOR (\d+)u?$/m.exec(text);
  if (!major || !minor) throw new Error("The plugin SDK header does not state its ABI version");
  return { abiMajor: Number(major[1]), abiMinor: Number(minor[1]) };
}

export function hostTarget(platform: string = process.platform, arch: string = process.arch): RegistryTarget {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`Registry packages are not built for ${platform} ${arch}`);
  return target;
}

/** Registry plugin commands for one project directory, against the real network and this machine's cache. */
export function registryPlugins(projectRoot: string, host: PluginHost = { target: hostTarget(), ...hostPluginAbi() }, cacheDirectory: string = process.env.CARBON_REGISTRY_CACHE || join(homedir(), ".carbon", "cache", "registry")): RegistryPlugins {
  return new RegistryPlugins(new NodePluginProject(projectRoot), new HttpRegistrySource(), new NodePackageCache(cacheDirectory), host);
}
