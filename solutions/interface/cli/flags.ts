// Flag parsing.
//
// Deliberately small. The ported V1 commands each hand-rolled a `while (i <
// args.length)` loop with slightly different rules — some accepted `--x=y`,
// some only `--x y`, one silently ignored unknown flags. This gives them one
// answer, and gives `--help` something to render from.

export interface FlagSpec {
  /** Long name, without `--`. */
  readonly name: string;
  /** Single-character alias, without `-`. */
  readonly short?: string;
  /** Shown in help. */
  readonly description: string;
  /** A boolean flag takes no value. */
  readonly boolean?: boolean;
  /** Placeholder shown in help for value flags, e.g. "<name>". */
  readonly placeholder?: string;
  /** Used when the flag is absent. */
  readonly default?: string | boolean;
}

export class Flags {
  private readonly values: ReadonlyMap<string, string | boolean>;

  constructor(values: Map<string, string | boolean>) {
    this.values = values;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  /** Value of a flag, or `fallback` when absent. */
  get(name: string, fallback?: string): string | undefined {
    const value = this.values.get(name);
    if (value === undefined) return fallback;
    return typeof value === "boolean" ? String(value) : value;
  }

  bool(name: string): boolean {
    return this.values.get(name) === true || this.values.get(name) === "true";
  }

  int(name: string, fallback: number): number {
    const raw = this.get(name);
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  static empty(): Flags {
    return new Flags(new Map());
  }
}

export interface ParsedArgv {
  readonly args: string[];
  readonly flags: Flags;
  /** Everything after a bare `--`, passed through untouched. */
  readonly passthrough: string[];
}

/**
 * Splits argv into positionals, flags and passthrough.
 *
 * `specs` is optional: when given, short aliases resolve to long names and
 * declared boolean flags never swallow the next token. Without it, a flag
 * followed by a non-flag token is treated as taking a value — the same
 * heuristic the V1 commands used.
 */
export function parseArgv(argv: readonly string[], specs: readonly FlagSpec[] = []): ParsedArgv {
  const byShort = new Map(specs.filter((s) => s.short).map((s) => [s.short!, s]));
  const byName = new Map(specs.map((s) => [s.name, s]));

  const args: string[] = [];
  const flags = new Map<string, string | boolean>();
  const passthrough: string[] = [];

  for (const spec of specs) {
    if (spec.default !== undefined) flags.set(spec.name, spec.default);
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "--") {
      passthrough.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const name = token.slice(2);
      const spec = byName.get(name);
      if (spec?.boolean) {
        flags.set(name, true);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        flags.set(name, argv[++i]);
      } else {
        flags.set(name, true);
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const spec = byShort.get(token.slice(1));
      const name = spec?.name ?? token.slice(1);
      if (spec?.boolean) {
        flags.set(name, true);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        flags.set(name, argv[++i]);
      } else {
        flags.set(name, true);
      }
      continue;
    }

    args.push(token);
  }

  return { args, flags: new Flags(flags), passthrough };
}
