// The TypeScript the toolchain validates manifests with.
//
// This is the rendering the CLI reads: `carbon plugin check` resolves the ids
// in a plugin's manifest against `EXTENSION_POINTS`, and `carbon run`'s
// preflight uses each point's capability to say which grants the host app is
// missing before the runtime says it in a stderr line nobody reads.
//
// It emits const data plus a literal union of the ids, so a typo in toolchain
// code that names a point is a compile error rather than a lookup miss.

import type { ExtensionPointRegistry } from "../../entities/ExtensionPoint.ts";
import { GENERATED_BANNER, wrapComment } from "./banner.ts";

export const TYPESCRIPT_PATH = "solutions/contracts/plugin/types/ExtensionPoints.ts";

export function renderTypeScript(registry: ExtensionPointRegistry): string {
  const out: string[] = [];

  for (const line of GENERATED_BANNER) out.push(`// ${line}`.trimEnd());
  out.push("");
  out.push("// The extension points a Carbon plugin may implement, as the toolchain sees");
  out.push("// them. The runtime enforces these; the toolchain's job is to say so before");
  out.push("// the app is launched, when the message can still name a file to edit.");
  out.push("");

  out.push('export type ExtensionPointArity = "many" | "exclusive";');
  out.push('export type ExtensionPointStability = "stable" | "experimental";');
  out.push("");

  out.push("/** Every id in the registry. A typo here is a compile error. */");
  out.push("export type ExtensionPointId =");
  registry.points.forEach((point, index) => {
    const last = index === registry.points.length - 1;
    out.push(`  | "${point.id}"${last ? ";" : ""}`);
  });
  out.push("");

  out.push("export interface ExtensionPointParam {");
  out.push("  readonly name: string;");
  out.push("  /** The C spelling, for documentation and error messages. */");
  out.push("  readonly type: string;");
  out.push("  readonly doc: string;");
  out.push("}");
  out.push("");

  out.push("export interface ExtensionPointSpec {");
  out.push("  readonly id: ExtensionPointId;");
  out.push("  /** The symbol a plugin exports to implement it. */");
  out.push("  readonly symbol: string;");
  out.push("  /** ABI minor this point appeared in. */");
  out.push("  readonly sinceMinor: number;");
  out.push("  readonly stability: ExtensionPointStability;");
  out.push("  readonly arity: ExtensionPointArity;");
  out.push("  /** Capability the host app must grant, or null when unprivileged. */");
  out.push("  readonly capability: string | null;");
  out.push("  readonly params: readonly ExtensionPointParam[];");
  out.push("  readonly returns: string;");
  out.push("  /** When the runtime calls it. */");
  out.push("  readonly dispatch: string;");
  out.push("  readonly doc: string;");
  out.push("}");
  out.push("");

  out.push("/** The ABI minor implied by the registry. */");
  out.push(`export const EXTENSION_POINTS_MINOR = ${registry.impliedAbiMinor};`);
  out.push("");

  out.push("export const EXTENSION_POINTS: readonly ExtensionPointSpec[] = [");
  for (const point of registry.points) {
    out.push("  {");
    out.push(`    id: "${point.id}",`);
    out.push(`    symbol: "${point.symbol}",`);
    out.push(`    sinceMinor: ${point.sinceMinor},`);
    out.push(`    stability: "${point.stability}",`);
    out.push(`    arity: "${point.arity}",`);
    out.push(`    capability: ${point.capability === null ? "null" : `"${point.capability}"`},`);
    if (point.params.length === 0) {
      out.push("    params: [],");
    } else {
      out.push("    params: [");
      for (const param of point.params) {
        out.push("      {");
        out.push(`        name: "${param.name}",`);
        out.push(`        type: "${param.type.c}",`);
        out.push(`        doc: ${JSON.stringify(param.doc)},`);
        out.push("      },");
      }
      out.push("    ],");
    }
    out.push(`    returns: "${point.returns.c}",`);
    out.push(`    dispatch: ${JSON.stringify(point.dispatch)},`);
    out.push(`    doc: ${JSON.stringify(point.doc)},`);
    out.push("  },");
  }
  out.push("] as const;");
  out.push("");

  out.push("const BY_ID = new Map<string, ExtensionPointSpec>(");
  out.push("  EXTENSION_POINTS.map((point) => [point.id, point]),");
  out.push(");");
  out.push("");

  out.push("/** The point with this id, or undefined. */");
  out.push("export function extensionPoint(id: string): ExtensionPointSpec | undefined {");
  out.push("  return BY_ID.get(id);");
  out.push("}");
  out.push("");

  out.push("export function isExtensionPointId(id: string): id is ExtensionPointId {");
  out.push("  return BY_ID.has(id);");
  out.push("}");
  out.push("");

  out.push("/** Every id, for error messages that should list the alternatives. */");
  out.push("export const EXTENSION_POINT_IDS: readonly string[] =");
  out.push("  EXTENSION_POINTS.map((point) => point.id);");
  out.push("");

  const capabilities = registry.capabilities;
  out.push("/**");
  for (const line of wrapComment(
    "Every capability some point gates on. A host app granting none of these " +
      "can still load a plugin — most points only observe — so this is the " +
      "list of grants that unlock something, not a list of requirements.",
    74,
  )) {
    out.push(` * ${line}`.trimEnd());
  }
  out.push(" */");
  out.push("export const EXTENSION_POINT_CAPABILITIES: readonly string[] = [");
  for (const capability of capabilities) out.push(`  "${capability}",`);
  out.push("];");
  out.push("");
  return out.join("\n");
}
