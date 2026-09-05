// identifiers.ts's assertValidIdentifier/quoteIdent is the ONE thing
// standing between a developer-supplied table/column/project name and a
// SQL-injection-via-identifier bug (see that file's own header comment
// for why this is real, not theoretical) — pure logic, cheap to verify
// directly, and important enough to deserve real unit coverage rather
// than only being exercised incidentally by the docker end-to-end pass.

import { describe, expect, test } from "bun:test";
import { assertValidIdentifier, InvalidIdentifierError, projectSchema, quoteIdent } from "../infrastructure/persistence/identifiers.ts";

describe("assertValidIdentifier", () => {
  test("accepts plain word identifiers", () => {
    expect(assertValidIdentifier("users")).toBe("users");
    expect(assertValidIdentifier("_private")).toBe("_private");
    expect(assertValidIdentifier("col_1")).toBe("col_1");
  });

  test("accepts hyphenated identifiers (project ids)", () => {
    expect(assertValidIdentifier("proj-1234abcd")).toBe("proj-1234abcd");
  });

  test("rejects an identifier starting with a digit", () => {
    expect(() => assertValidIdentifier("1table")).toThrow(InvalidIdentifierError);
  });

  test("rejects a SQL-injection attempt via identifier", () => {
    expect(() => assertValidIdentifier('x"; DROP TABLE users; --')).toThrow(InvalidIdentifierError);
  });

  test("rejects double quotes, spaces, and dots", () => {
    expect(() => assertValidIdentifier('has"quote')).toThrow();
    expect(() => assertValidIdentifier("has space")).toThrow();
    expect(() => assertValidIdentifier("has.dot")).toThrow();
  });

  test("rejects an identifier over 63 bytes (Postgres's own limit)", () => {
    expect(() => assertValidIdentifier("a".repeat(64))).toThrow();
    expect(assertValidIdentifier("a".repeat(63))).toHaveLength(63);
  });
});

describe("quoteIdent", () => {
  test("wraps a valid identifier in double quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
  });

  test("throws (does not silently escape) an invalid identifier", () => {
    expect(() => quoteIdent('bad"name')).toThrow(InvalidIdentifierError);
  });
});

describe("projectSchema", () => {
  test("maps a project id to a schema name with underscores, not hyphens", () => {
    expect(projectSchema("proj-1234abcd")).toBe("proj_proj_1234abcd");
  });

  test("rejects an invalid project id before building a schema name from it", () => {
    expect(() => projectSchema('bad"proj')).toThrow(InvalidIdentifierError);
  });
});
