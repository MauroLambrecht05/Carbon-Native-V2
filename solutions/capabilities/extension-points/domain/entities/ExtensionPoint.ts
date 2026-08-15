// One extension point, and the registry of all of them.
//
// The model the Zig registry parses into and every renderer reads from. Pure:
// it does not know it came from Zig, and it does not know C, Rust or
// TypeScript exist.

import { RegistryInvariantError, UnknownExtensionPointError } from "../errors/ExtensionPointError.ts";
import { valueType, type ValueType } from "../value-objects/ValueType.ts";

export type Arity = "many" | "exclusive";
export type Stability = "stable" | "experimental";

export interface Param {
  readonly name: string;
  readonly type: ValueType;
  readonly doc: string;
}

export class ExtensionPoint {
  constructor(
    readonly id: string,
    readonly symbol: string,
    readonly sinceMinor: number,
    readonly stability: Stability,
    readonly arity: Arity,
    /** null when the point is unprivileged. */
    readonly capability: string | null,
    readonly params: readonly Param[],
    readonly returns: ValueType,
    readonly dispatch: string,
    readonly doc: string,
  ) {}

  /** `lifecycle.register` -> `lifecycle`. */
  get area(): string {
    return this.id.split(".")[0];
  }

  /** `lifecycle.register` -> `LIFECYCLE_REGISTER`, for generated constants. */
  get constantName(): string {
    return this.id.replace(/[.\-]/g, "_").toUpperCase();
  }

  /** `lifecycle.register` -> `lifecycleRegister`, for generated TS members. */
  get camelName(): string {
    return this.id
      .split(/[.\-_]/)
      .map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
      .join("");
  }

  /** `lifecycle.register` -> `LifecycleRegister`, for generated Rust variants. */
  get pascalName(): string {
    const camel = this.camelName;
    return camel[0].toUpperCase() + camel.slice(1);
  }

  get isExperimental(): boolean {
    return this.stability === "experimental";
  }

  get isExclusive(): boolean {
    return this.arity === "exclusive";
  }
}

export class ExtensionPointRegistry {
  private readonly byId: ReadonlyMap<string, ExtensionPoint>;

  constructor(readonly points: readonly ExtensionPoint[]) {
    const byId = new Map<string, ExtensionPoint>();
    const bySymbol = new Map<string, ExtensionPoint>();

    for (const point of points) {
      // The same two invariants the Zig file asserts at comptime. Checked
      // again here rather than trusted, because the generator PARSES that
      // file rather than executing it — a comptime check nothing in this
      // pipeline runs is a check that only fires when a plugin is built.
      const clashingId = byId.get(point.id);
      if (clashingId) {
        throw new RegistryInvariantError(`duplicate extension point id: ${point.id}`);
      }
      const clashingSymbol = bySymbol.get(point.symbol);
      if (clashingSymbol) {
        throw new RegistryInvariantError(
          `extension points "${clashingSymbol.id}" and "${point.id}" both export ` +
            `"${point.symbol}" — one plugin's implementation would answer for both`,
        );
      }
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(point.id)) {
        throw new RegistryInvariantError(
          `extension point id "${point.id}" is not <area>.<verb> in lower_snake_case`,
        );
      }
      byId.set(point.id, point);
      bySymbol.set(point.symbol, point);
    }

    this.byId = byId;
  }

  get(id: string): ExtensionPoint | undefined {
    return this.byId.get(id);
  }

  /** Throws with the list of known ids, which is what the author needs. */
  require(id: string): ExtensionPoint {
    const found = this.byId.get(id);
    if (!found) throw new UnknownExtensionPointError(id, this.ids);
    return found;
  }

  get ids(): string[] {
    return this.points.map((p) => p.id);
  }

  /** Every capability any point gates on, deduplicated and sorted. */
  get capabilities(): string[] {
    const set = new Set<string>();
    for (const point of this.points) {
      if (point.capability) set.add(point.capability);
    }
    return [...set].sort();
  }

  /** Points grouped by area, in declaration order within each. */
  byArea(): Map<string, ExtensionPoint[]> {
    const areas = new Map<string, ExtensionPoint[]>();
    for (const point of this.points) {
      const list = areas.get(point.area) ?? [];
      list.push(point);
      areas.set(point.area, list);
    }
    return areas;
  }

  /** The highest `since_minor` in the registry — the ABI minor it implies. */
  get impliedAbiMinor(): number {
    return this.points.reduce((max, p) => Math.max(max, p.sinceMinor), 0);
  }
}

/** Convenience for renderers that need the C spelling of a param list. */
export function paramType(id: string): ValueType {
  return valueType(id);
}
