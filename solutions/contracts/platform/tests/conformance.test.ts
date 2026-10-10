import { describe, expect, test } from "bun:test";
import { ContractError, parseComponent } from "../validation.ts";
import { fixtures } from "../fixtures/conformance.ts";
import schema from "../schema/platform.schema.json";
import type { Components } from "../types/Platform.ts";

describe("platform v1 wire conformance", () => {
  test("every schema component has a typed, runtime-valid fixture", () => {
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(schema.$defs).sort());
    for (const component of Object.keys(fixtures) as (keyof Components)[]) {
      expect(parseComponent(component, fixtures[component])).toEqual(fixtures[component]);
    }
  });
  test("rejects noncanonical decimals without floating point conversion", () => {
    for (const input of [1.5, "1.0", "01", "-0", "1e3", "+1", "NaN", "0.00"]) expect(() => parseComponent("Decimal", input)).toThrow(ContractError);
    for (const input of ["0", "-0.001", "9007199254740993", "12345678901234567890.123456789"]) expect(parseComponent("Decimal", input)).toBe(input);
  });
  test("validates resource hierarchy and principal audience", () => {
    expect(() => parseComponent("Scope", { orgId: fixtures.Id, environmentId: fixtures.Id })).toThrow(ContractError);
    expect(() => parseComponent("Principal", { ...fixtures.Principal, audience: "operator" })).toThrow(ContractError);
    expect(() => parseComponent("Principal", { ...fixtures.Principal, kind: "app_user" })).toThrow(ContractError);
  });
  test("rejects secret fields in persistent/public projections", () => {
    for (const component of ["Operation", "AuditRecord", "PlatformEvent", "SafeMetadata", "ServiceError"] as const) {
      expect(() => parseComponent(component, { ...fixtures[component], token: "secret-value" })).toThrow(ContractError);
    }
    expect(() => parseComponent("SafeMetadata", { password: "secret-value" })).toThrow(ContractError);
    try { parseComponent("ServiceError", { token: "secret-value" }); } catch (error) { expect(String(error)).not.toContain("secret-value"); }
  });
  test("requires UTC dates, safe revisions and bounded pages", () => {
    for (const input of ["2026-09-12T08:00:00+02:00", "2026-02-30T08:00:00Z", "today"]) expect(() => parseComponent("Timestamp", input)).toThrow(ContractError);
    for (const input of [0, "0", "1.0", "01", "1e6"]) expect(() => parseComponent("Revision", input)).toThrow(ContractError);
    expect(() => parseComponent("PageRequest", { limit: 10000 })).toThrow(ContractError);
  });
});
