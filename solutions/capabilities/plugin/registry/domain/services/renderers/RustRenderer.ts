// The Rust the runtime dispatches through.
//
// Emitted as DATA, not code: a `PointId` enum, a `POINTS` table carrying each
// point's symbol, capability, arity and stability, and one function-pointer
// typedef per point. The loader walks the table — it does not have a branch
// per point — so adding a point to the registry adds a row here and nothing
// else has to change until the runtime chooses to call it.
//
// That is the opposite of the C header, which emits prototypes so the plugin's
// compiler can check a signature. The two sides need different things from the
// same registry, which is the reason both are generated rather than shared.

import type { ExtensionPoint, ExtensionPointRegistry } from "../../entities/ExtensionPoint.ts";
import { GENERATED_BANNER, wrapComment } from "./banner.ts";

export const RUST_PATH = "solutions/contracts/plugin/rust/generated.rs";

export function renderRust(registry: ExtensionPointRegistry): string {
  const out: string[] = [];

  for (const line of GENERATED_BANNER) out.push(`// ${line}`.trimEnd());
  out.push("");
  out.push("// The extension points a plugin may implement, as data the loader walks.");
  out.push("//");
  out.push("// `PointId` is `#[non_exhaustive]`-shaped in spirit but not in attribute: the");
  out.push("// runtime matches on it exhaustively on purpose, so that appending a point to");
  out.push("// the registry produces a compile error at every place that decides what to do");
  out.push("// with one. A silently-ignored new point is the failure this table exists to");
  out.push("// prevent.");
  out.push("");
  out.push("use core::ffi::c_char;");
  out.push("");
  out.push("use crate::CarbonApp;");
  out.push("");

  out.push("/// The ABI minor implied by the registry — the highest `since_minor` in it.");
  out.push(`pub const EXTENSION_POINTS_MINOR: u32 = ${registry.impliedAbiMinor};`);
  out.push("");

  out.push("/// How many plugins may implement one point.");
  out.push("#[derive(Debug, Clone, Copy, PartialEq, Eq)]");
  out.push("pub enum Arity {");
  out.push("    /// Every implementor is called, in load order.");
  out.push("    Many,");
  out.push("    /// At most one plugin may implement it; the loader refuses the second.");
  out.push("    Exclusive,");
  out.push("}");
  out.push("");

  out.push("/// What a plugin author may rely on.");
  out.push("#[derive(Debug, Clone, Copy, PartialEq, Eq)]");
  out.push("pub enum Stability {");
  out.push("    Stable,");
  out.push("    /// May change within an ABI major. The loader warns on use.");
  out.push("    Experimental,");
  out.push("}");
  out.push("");

  // ── PointId ──────────────────────────────────────────────────────────────
  out.push("/// Every point in the registry, in declaration order.");
  out.push("#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]");
  out.push("pub enum PointId {");
  for (const point of registry.points) {
    out.push(`    /// \`${point.id}\``);
    out.push(`    ${point.pascalName},`);
  }
  out.push("}");
  out.push("");

  out.push("impl PointId {");
  out.push("    /// The id as written in a plugin manifest.");
  out.push("    pub const fn as_str(self) -> &'static str {");
  out.push("        match self {");
  for (const point of registry.points) {
    out.push(`            PointId::${point.pascalName} => "${point.id}",`);
  }
  out.push("        }");
  out.push("    }");
  out.push("");
  out.push("    /// Resolve a manifest string to a point. `None` means the plugin was");
  out.push("    /// built against a registry this runtime does not have.");
  out.push("    pub fn parse(id: &str) -> Option<Self> {");
  out.push("        match id {");
  for (const point of registry.points) {
    out.push(`            "${point.id}" => Some(PointId::${point.pascalName}),`);
  }
  out.push("            _ => None,");
  out.push("        }");
  out.push("    }");
  out.push("");
  out.push("    /// The row describing this point.");
  out.push("    pub fn spec(self) -> &'static PointSpec {");
  out.push("        &POINTS[self as usize]");
  out.push("    }");
  out.push("}");
  out.push("");

  // ── PointSpec ────────────────────────────────────────────────────────────
  out.push("/// One row of the registry.");
  out.push("#[derive(Debug)]");
  out.push("pub struct PointSpec {");
  out.push("    pub id: PointId,");
  out.push("    /// The exported symbol the loader resolves. NUL-terminated so it can go");
  out.push("    /// straight to `libloading::Library::get` without an allocation.");
  out.push("    pub symbol: &'static [u8],");
  out.push("    pub since_minor: u32,");
  out.push("    pub stability: Stability,");
  out.push("    pub arity: Arity,");
  out.push("    /// Capability the host app must grant before a plugin implementing this");
  out.push("    /// point will load. `None` means the point only observes.");
  out.push("    pub capability: Option<&'static str>,");
  out.push("}");
  out.push("");

  out.push("/// Indexed by `PointId as usize` — `PointId::spec` relies on that, and the");
  out.push("/// generator emits the rows in enum order to keep it true.");
  out.push(`pub static POINTS: [PointSpec; ${registry.points.length}] = [`);
  for (const point of registry.points) {
    out.push("    PointSpec {");
    out.push(`        id: PointId::${point.pascalName},`);
    out.push(`        symbol: b"${point.symbol}\\0",`);
    out.push(`        since_minor: ${point.sinceMinor},`);
    out.push(`        stability: Stability::${point.isExperimental ? "Experimental" : "Stable"},`);
    out.push(`        arity: Arity::${point.isExclusive ? "Exclusive" : "Many"},`);
    out.push(
      `        capability: ${point.capability === null ? "None" : `Some("${point.capability}")`},`,
    );
    out.push("    },");
  }
  out.push("];");
  out.push("");

  out.push("impl PointSpec {");
  out.push("    /// The exported symbol without its trailing NUL, for messages.");
  out.push("    pub fn symbol_str(&self) -> &'static str {");
  out.push("        match core::str::from_utf8(&self.symbol[..self.symbol.len() - 1]) {");
  out.push("            Ok(s) => s,");
  out.push('            Err(_) => "<non-utf8 symbol>",');
  out.push("        }");
  out.push("    }");
  out.push("}");
  out.push("");

  // ── Signatures ───────────────────────────────────────────────────────────
  out.push("// ── Signatures ─────────────────────────────────────────────────────────────");
  out.push("//");
  out.push("// One typedef per point, so the loader transmutes a resolved symbol into a");
  out.push("// type that came from the same registry the plugin compiled against rather");
  out.push("// than one written out by hand next to it.");
  out.push("");
  for (const point of registry.points) {
    for (const line of wrapComment(`\`${point.id}\` — ${point.dispatch}`, 76)) {
      out.push(`/// ${line}`.trimEnd());
    }
    out.push(`pub type ${point.pascalName}Fn = unsafe extern "C" fn(${rustParams(point)})${rustReturn(point)};`);
    out.push("");
  }

  // The c_char import is only used by points taking a `str` param. Reference
  // it unconditionally so the generated file compiles either way rather than
  // emitting a conditional import the generator has to reason about.
  out.push("/// Keeps `c_char` used when no point in the registry takes a string.");
  out.push("#[allow(dead_code)]");
  out.push("type _KeepCCharUsed = *const c_char;");
  out.push("");
  return out.join("\n");
}

function rustParams(point: ExtensionPoint): string {
  const params = ["app: *mut CarbonApp", ...point.params.map((p) => `${p.name}: ${p.type.rust}`)];
  return params.join(", ");
}

function rustReturn(point: ExtensionPoint): string {
  return point.returns.id === "void" ? "" : ` -> ${point.returns.rust}`;
}
