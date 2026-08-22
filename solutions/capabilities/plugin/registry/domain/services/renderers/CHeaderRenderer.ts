// The C header a plugin author compiles against.
//
// Emitted as declarations rather than a table: a plugin implements a point by
// exporting a function with the right name and signature, and the compiler
// checking that signature against a prototype is the whole benefit. A struct
// of function pointers would move the check to runtime.

import type { ExtensionPointRegistry, ExtensionPoint } from "../../entities/ExtensionPoint.ts";
import { GENERATED_BANNER, wrapComment } from "./banner.ts";

export const C_HEADER_PATH = "solutions/contracts/plugin/abi/carbon_extension_points.h";

export function renderCHeader(registry: ExtensionPointRegistry): string {
  const out: string[] = [];

  out.push("/*");
  for (const line of GENERATED_BANNER) out.push(` * ${line}`.trimEnd());
  out.push(" *");
  out.push(" * The extension points a Carbon plugin may implement.");
  out.push(" *");
  out.push(" * Every point is OPTIONAL. The host resolves each by symbol name at load");
  out.push(" * time and skips the ones a plugin does not export, which is what makes");
  out.push(" * appending a point a MINOR ABI bump rather than a break.");
  out.push(" *");
  out.push(" * Include carbon_plugin.h first — every prototype below takes CarbonApp*.");
  out.push(" */");
  out.push("#ifndef CARBON_EXTENSION_POINTS_H");
  out.push("#define CARBON_EXTENSION_POINTS_H");
  out.push("");
  out.push("#include <stddef.h>");
  out.push("#include <stdint.h>");
  out.push('#include "carbon_plugin.h"');
  out.push("");
  out.push("#ifdef __cplusplus");
  out.push('extern "C" {');
  out.push("#endif");
  out.push("");
  out.push(`/* The ABI minor implied by this registry. */`);
  out.push(`#define CARBON_EXTENSION_POINTS_MINOR ${registry.impliedAbiMinor}u`);
  out.push(`#define CARBON_EXTENSION_POINT_COUNT ${registry.points.length}`);
  out.push("");

  for (const [area, points] of registry.byArea()) {
    out.push(`/* ── ${area} ${"─".repeat(Math.max(0, 66 - area.length))} */`);
    out.push("");
    for (const point of points) out.push(...renderPoint(point));
  }

  out.push("#ifdef __cplusplus");
  out.push("} /* extern \"C\" */");
  out.push("#endif");
  out.push("");
  out.push("#endif /* CARBON_EXTENSION_POINTS_H */");
  out.push("");
  return out.join("\n");
}

function renderPoint(point: ExtensionPoint): string[] {
  const out: string[] = [];

  out.push("/*");
  out.push(` * ${point.id}`);
  out.push(" *");
  for (const line of wrapComment(point.doc, 72)) out.push(` * ${line}`.trimEnd());
  out.push(" *");
  for (const line of wrapComment(`Dispatch: ${point.dispatch}`, 72)) {
    out.push(` * ${line}`.trimEnd());
  }
  out.push(` * Since:    ABI 1.${point.sinceMinor}`);
  out.push(` * Arity:    ${point.arity}${point.isExclusive ? " — at most one plugin may implement it" : ""}`);
  out.push(
    ` * Requires: ${point.capability ?? "no capability — this point only observes"}`,
  );
  if (point.isExperimental) {
    out.push(" *");
    out.push(" * EXPERIMENTAL: may change signature or disappear within ABI major 1.");
  }
  for (const param of point.params) {
    out.push(" *");
    for (const line of wrapComment(`@param ${param.name} ${param.doc}`, 72)) {
      out.push(` * ${line}`.trimEnd());
    }
  }
  out.push(" */");

  const params = ["CarbonApp* app", ...point.params.map((p) => `${p.type.c} ${p.name}`)];
  out.push(`${point.returns.c} ${point.symbol}(${params.join(", ")});`);
  out.push("");
  return out;
}
