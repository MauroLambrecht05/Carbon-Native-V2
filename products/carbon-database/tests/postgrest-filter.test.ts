// parseFilter is postgrest.ts's one pure function (URL query param ->
// filter descriptor) — real unit coverage here; handlePostgrestRequest
// itself needs a real DatabaseEngine (Postgres) and is verified via the
// docker end-to-end pass instead (see this product's README).

import { describe, expect, test } from "bun:test";
import { parseFilter } from "../infrastructure/http/postgrest.ts";

describe("parseFilter", () => {
  test("a bare value with no operator prefix defaults to eq", () => {
    expect(parseFilter("name", "Alice")).toEqual({ column: "name", operator: "eq", value: "Alice" });
  });

  test("eq/neq/gt/gte/lt/lte parse their operator and coerce numeric literals", () => {
    expect(parseFilter("age", "eq.30")).toEqual({ column: "age", operator: "eq", value: 30 });
    expect(parseFilter("age", "neq.30")).toEqual({ column: "age", operator: "neq", value: 30 });
    expect(parseFilter("age", "gt.30")).toEqual({ column: "age", operator: "gt", value: 30 });
    expect(parseFilter("age", "gte.30")).toEqual({ column: "age", operator: "gte", value: 30 });
    expect(parseFilter("age", "lt.30")).toEqual({ column: "age", operator: "lt", value: 30 });
    expect(parseFilter("age", "lte.30")).toEqual({ column: "age", operator: "lte", value: 30 });
  });

  test("like strips the wildcard asterisks", () => {
    expect(parseFilter("name", "like.*ali*")).toEqual({ column: "name", operator: "like", value: "ali" });
  });

  test("is parses null/true/false as real literals, not strings", () => {
    expect(parseFilter("deleted_at", "is.null")).toEqual({ column: "deleted_at", operator: "is", value: null });
    expect(parseFilter("active", "is.true")).toEqual({ column: "active", operator: "is", value: true });
    expect(parseFilter("active", "is.false")).toEqual({ column: "active", operator: "is", value: false });
  });

  test("in parses a parenthesized comma list into an array of literals", () => {
    expect(parseFilter("role", "in.(admin,editor,42)")).toEqual({
      column: "role",
      operator: "in",
      value: ["admin", "editor", 42],
    });
  });

  test("an unrecognized operator prefix falls back to eq on the literal", () => {
    expect(parseFilter("x", "bogus.5")).toEqual({ column: "x", operator: "eq", value: 5 });
  });
});
