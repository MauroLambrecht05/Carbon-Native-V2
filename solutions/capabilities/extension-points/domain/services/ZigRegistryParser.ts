// Reading the Zig registry.
//
// ── WHY PARSE ZIG RATHER THAN EXECUTE IT ────────────────────────────────────
// Executing it would mean `zig build` — and therefore a Zig toolchain — on
// every machine that generates or merely CHECKS the artifacts, which is every
// CI run and every `carbon run`. A plugin author needs Zig; the toolchain
// should not.
//
// That is affordable only because the registry is written in a deliberately
// restricted subset: one array of struct literals, whose field values are
// strings, multi-line strings, integers, enum literals, `null`, and slices of
// struct literals. No expressions, no comptime, no imports referenced from
// inside the array. The parser below covers exactly that subset and refuses
// anything else by name rather than guessing.
//
// The Zig file also asserts its own invariants at comptime, and
// ExtensionPointRegistry re-asserts them. That duplication is deliberate: the
// comptime checks fire when a PLUGIN is built, these fire when the artifacts
// are generated, and neither audience runs the other's.

import {
  ExtensionPoint,
  ExtensionPointRegistry,
  type Arity,
  type Param,
  type Stability,
} from "../entities/ExtensionPoint.ts";
import { RegistryParseError } from "../errors/ExtensionPointError.ts";
import { valueType } from "../value-objects/ValueType.ts";

/** Anything the restricted subset can produce. */
type ZigValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "enum"; value: string }
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "struct"; fields: Map<string, ZigValue> }
  | { kind: "array"; items: ZigValue[] };

const ARITIES: readonly string[] = ["many", "exclusive"];
const STABILITIES: readonly string[] = ["stable", "experimental"];

class Cursor {
  private i = 0;

  constructor(private readonly src: string) {}

  get line(): number {
    let line = 1;
    for (let k = 0; k < this.i && k < this.src.length; k++) {
      if (this.src[k] === "\n") line++;
    }
    return line;
  }

  fail(message: string): never {
    throw new RegistryParseError(message, this.line);
  }

  atEnd(): boolean {
    return this.i >= this.src.length;
  }

  /** Whitespace and `//` line comments. Never called from inside a literal. */
  skipTrivia(): void {
    for (;;) {
      while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
      // `//` is a comment, but `\\` starting a line is a multi-line string and
      // must not be skipped — that distinction is the whole reason this is a
      // hand-written scanner rather than a regex strip.
      if (this.src.startsWith("//", this.i)) {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.i++;
        continue;
      }
      return;
    }
  }

  peek(): string {
    return this.src[this.i] ?? "";
  }

  startsWith(text: string): boolean {
    return this.src.startsWith(text, this.i);
  }

  /**
   * The next `n` characters, for the one decision a single character cannot
   * make: `.{` opens both a struct literal and an array literal, and telling
   * them apart means looking for `.field =`.
   */
  lookahead(n: number): string {
    return this.src.slice(this.i, this.i + n);
  }

  take(text: string): boolean {
    if (!this.startsWith(text)) return false;
    this.i += text.length;
    return true;
  }

  expect(text: string): void {
    if (!this.take(text)) this.fail(`expected ${JSON.stringify(text)}`);
  }

  /** A bare Zig identifier: field names and enum tags. */
  identifier(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    if (!match) this.fail("expected an identifier");
    this.i += match[0].length;
    return match[0];
  }

  stringLiteral(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      if (this.atEnd()) this.fail("unterminated string literal");
      const ch = this.src[this.i++];
      if (ch === '"') return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = this.src[this.i++];
      if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "r") out += "\r";
      else if (esc === '"' || esc === "\\" || esc === "'") out += esc;
      else this.fail(`unsupported escape \\${esc} in a registry string`);
    }
  }

  /**
   * A Zig multi-line string: one or more consecutive lines whose first
   * non-whitespace is `\\`. The content is everything after the marker,
   * verbatim — Zig applies no escapes inside these, which is why the docs in
   * the registry can contain backslashes and quotes without ceremony.
   */
  multilineString(): string {
    const lines: string[] = [];
    for (;;) {
      if (!this.startsWith("\\\\")) break;
      this.i += 2;
      let line = "";
      while (this.i < this.src.length && this.src[this.i] !== "\n") {
        line += this.src[this.i++];
      }
      lines.push(line);
      // Look ahead past the newline and any indentation for another marker.
      const save = this.i;
      while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
      if (!this.startsWith("\\\\")) {
        this.i = save;
        break;
      }
    }
    return lines.join("\n");
  }

  numberLiteral(): number {
    const match = /^-?\d+/.exec(this.src.slice(this.i));
    if (!match) this.fail("expected a number");
    this.i += match[0].length;
    return Number(match[0]);
  }
}

function parseValue(cursor: Cursor): ZigValue {
  cursor.skipTrivia();

  if (cursor.peek() === '"') {
    return { kind: "string", value: cursor.stringLiteral() };
  }
  if (cursor.startsWith("\\\\")) {
    return { kind: "string", value: cursor.multilineString() };
  }
  if (cursor.take("null")) {
    return { kind: "null" };
  }
  if (cursor.take("true")) return { kind: "bool", value: true };
  if (cursor.take("false")) return { kind: "bool", value: false };
  // `&.{ … }` — a slice literal. Zig also allows `&[_]T{…}`; the registry does
  // not use it, and accepting only one spelling keeps the failure obvious.
  if (cursor.startsWith("&")) {
    cursor.expect("&");
    cursor.skipTrivia();
    return parseBraced(cursor, "array");
  }
  if (cursor.startsWith(".{")) {
    return parseBraced(cursor, "struct");
  }
  if (cursor.peek() === ".") {
    cursor.expect(".");
    return { kind: "enum", value: cursor.identifier() };
  }
  if (/[-\d]/.test(cursor.peek())) {
    return { kind: "number", value: cursor.numberLiteral() };
  }
  cursor.fail(`unsupported value in the registry (starts with ${JSON.stringify(cursor.peek())})`);
}

/**
 * `.{ … }` is both a struct literal and an array literal in Zig — which one
 * depends on whether the contents are `.field = value` pairs. The caller says
 * which it expects, and a mismatch is reported rather than coerced.
 */
function parseBraced(cursor: Cursor, expected: "struct" | "array"): ZigValue {
  cursor.expect(".{");
  const fields = new Map<string, ZigValue>();
  const items: ZigValue[] = [];

  for (;;) {
    cursor.skipTrivia();
    if (cursor.take("}")) break;
    if (cursor.atEnd()) cursor.fail("unterminated literal");

    // A `.name = value` pair is a struct field; anything else is an element.
    const isField = /^\.[A-Za-z_][A-Za-z0-9_]*\s*=/.test(cursor.lookahead(128));
    if (isField) {
      cursor.expect(".");
      const name = cursor.identifier();
      cursor.skipTrivia();
      cursor.expect("=");
      fields.set(name, parseValue(cursor));
    } else {
      items.push(parseValue(cursor));
    }

    cursor.skipTrivia();
    // Trailing commas are idiomatic Zig and the registry uses them.
    cursor.take(",");
  }

  if (expected === "struct" && items.length > 0) {
    cursor.fail("expected a struct literal but found positional elements");
  }
  if (expected === "array" && fields.size > 0) {
    cursor.fail("expected a slice literal but found named fields");
  }
  return expected === "struct" ? { kind: "struct", fields } : { kind: "array", items };
}

// ── Field extraction ────────────────────────────────────────────────────────

function requireField(
  fields: Map<string, ZigValue>,
  name: string,
  context: string,
): ZigValue {
  const value = fields.get(name);
  if (value === undefined) {
    throw new RegistryParseError(`${context} is missing the field .${name}`);
  }
  return value;
}

function asString(value: ZigValue, context: string): string {
  if (value.kind !== "string") {
    throw new RegistryParseError(`${context} must be a string, got ${value.kind}`);
  }
  return value.value;
}

function asNumber(value: ZigValue, context: string): number {
  if (value.kind !== "number") {
    throw new RegistryParseError(`${context} must be a number, got ${value.kind}`);
  }
  return value.value;
}

function asEnum(value: ZigValue, allowed: readonly string[], context: string): string {
  if (value.kind !== "enum") {
    throw new RegistryParseError(`${context} must be an enum literal, got ${value.kind}`);
  }
  if (!allowed.includes(value.value)) {
    throw new RegistryParseError(
      `${context} is .${value.value}; allowed: ${allowed.map((a) => `.${a}`).join(", ")}`,
    );
  }
  return value.value;
}

function asNullableString(value: ZigValue, context: string): string | null {
  if (value.kind === "null") return null;
  return asString(value, context);
}

function parseParams(value: ZigValue, context: string): Param[] {
  if (value.kind !== "array") {
    throw new RegistryParseError(`${context}.params must be a slice, got ${value.kind}`);
  }
  return value.items.map((item, index) => {
    if (item.kind !== "struct") {
      throw new RegistryParseError(`${context}.params[${index}] must be a struct literal`);
    }
    const where = `${context}.params[${index}]`;
    return {
      name: asString(requireField(item.fields, "name", where), `${where}.name`),
      // `.type` is a Zig keyword-adjacent field name but a perfectly legal one,
      // and it is what reads best on the Zig side.
      type: valueType(
        asEnum(requireField(item.fields, "type", where), VALUE_TYPE_NAMES, `${where}.type`),
      ),
      doc: asString(requireField(item.fields, "doc", where), `${where}.doc`),
    };
  });
}

// Kept as a plain list rather than importing VALUE_TYPE_IDS so the error
// message orders them the way the Zig enum declares them.
const VALUE_TYPE_NAMES = ["void", "app", "u32", "i32", "boolean", "str", "bytes_mut"];

// ── The entry point ─────────────────────────────────────────────────────────

const POINTS_DECLARATION = "pub const POINTS = [_]ExtensionPoint{";

/**
 * Parse `extension-points.zig` into a registry.
 *
 * Takes the file's text, not a path: the whole point of putting this in
 * domain/ is that the rules can be exercised against a string literal, and
 * every test in this capability does exactly that.
 */
export function parseZigRegistry(source: string): ExtensionPointRegistry {
  const start = source.indexOf(POINTS_DECLARATION);
  if (start < 0) {
    throw new RegistryParseError(
      `could not find "${POINTS_DECLARATION}" — the registry must declare its ` +
        "points as one array of that exact form",
    );
  }

  // Walk from the opening brace to its match, so a `}` inside a doc string
  // cannot end the array early.
  const open = start + POINTS_DECLARATION.length - 1;
  const body = extractBracedBody(source, open);

  const cursor = new Cursor(body);
  const points: ExtensionPoint[] = [];

  for (;;) {
    cursor.skipTrivia();
    if (cursor.atEnd()) break;

    const literal = parseBraced(cursor, "struct");
    if (literal.kind !== "struct") throw new RegistryParseError("expected a point literal");

    const id = asString(requireField(literal.fields, "id", "extension point"), "id");
    const where = `extension point "${id}"`;

    points.push(
      new ExtensionPoint(
        id,
        asString(requireField(literal.fields, "symbol", where), `${where}.symbol`),
        asNumber(requireField(literal.fields, "since_minor", where), `${where}.since_minor`),
        asEnum(
          requireField(literal.fields, "stability", where),
          STABILITIES,
          `${where}.stability`,
        ) as Stability,
        asEnum(requireField(literal.fields, "arity", where), ARITIES, `${where}.arity`) as Arity,
        asNullableString(
          requireField(literal.fields, "capability", where),
          `${where}.capability`,
        ),
        parseParams(requireField(literal.fields, "params", where), where),
        valueType(
          asEnum(requireField(literal.fields, "returns", where), VALUE_TYPE_NAMES, `${where}.returns`),
        ),
        asString(requireField(literal.fields, "dispatch", where), `${where}.dispatch`),
        asString(requireField(literal.fields, "doc", where), `${where}.doc`),
      ),
    );

    cursor.skipTrivia();
    cursor.take(",");
  }

  if (points.length === 0) {
    throw new RegistryParseError("the registry declares no extension points");
  }
  return new ExtensionPointRegistry(points);
}

/**
 * Everything between `source[open]` (a `{`) and its matching `}`, skipping
 * braces that appear inside string literals, multi-line strings and comments.
 */
function extractBracedBody(source: string, open: number): string {
  let depth = 0;
  let i = open;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (source.startsWith("\\\\", i) || source.startsWith("//", i)) {
      // Both run to end of line, and neither can contain a brace that counts.
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
    i++;
  }
  throw new RegistryParseError("POINTS array is never closed");
}
