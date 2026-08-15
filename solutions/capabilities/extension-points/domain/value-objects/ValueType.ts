// The types a point's parameters and return may use, and how each one spells
// itself in the three languages that are generated.
//
// The set is deliberately tiny — it mirrors `ValueType` in the Zig registry,
// and the reason it is small is written down there: anything richer than a
// scalar, an opaque host pointer, a host-owned string or an explicit byte span
// would need an allocator agreement across a DLL boundary.
//
// Keeping the three spellings in one table rather than one per renderer is
// what makes "add a type" a single edit. It also means a type that cannot be
// expressed in one of the three languages is impossible to add by accident.

import { ExtensionPointError } from "../errors/ExtensionPointError.ts";

export type ValueTypeId =
  | "void"
  | "app"
  | "u32"
  | "i32"
  | "boolean"
  | "str"
  | "bytes_mut";

export interface ValueType {
  readonly id: ValueTypeId;
  /** How it appears in the generated C header. */
  readonly c: string;
  /** How it appears in the generated Rust `extern "C" fn` type. */
  readonly rust: string;
  /** How it appears in the generated TypeScript, for documentation only. */
  readonly ts: string;
}

const TYPES: Record<ValueTypeId, ValueType> = {
  void: { id: "void", c: "void", rust: "()", ts: "void" },
  // Never appears in a params list — every point takes `CarbonApp* app`
  // implicitly and the registry does not restate it. It is here so the return
  // position can name it if a future point hands one back.
  //
  // The Rust spelling is the contract crate's OPAQUE `CarbonApp`, not the
  // runtime's concrete `HostCarbonApp`. Contracts depend on nothing, so the
  // generated table cannot name a type that lives in the host — the host casts
  // its own pointer to this one at the dispatch site.
  app: { id: "app", c: "CarbonApp*", rust: "*mut CarbonApp", ts: "CarbonApp" },
  u32: { id: "u32", c: "uint32_t", rust: "u32", ts: "number" },
  i32: { id: "i32", c: "int32_t", rust: "i32", ts: "number" },
  // C89 has no bool and this ABI predates stdbool, so the wire type is a
  // 32-bit int and the *name* carries the intent.
  boolean: { id: "boolean", c: "int32_t", rust: "i32", ts: "boolean" },
  str: { id: "str", c: "const char*", rust: "*const c_char", ts: "string" },
  bytes_mut: { id: "bytes_mut", c: "uint8_t*", rust: "*mut u8", ts: "Uint8Array" },
};

export const VALUE_TYPE_IDS = Object.keys(TYPES) as ValueTypeId[];

export function valueType(id: string): ValueType {
  const found = TYPES[id as ValueTypeId];
  if (!found) {
    throw new ExtensionPointError(
      `unknown value type "${id}". The registry may use: ${VALUE_TYPE_IDS.join(", ")}`,
    );
  }
  return found;
}
