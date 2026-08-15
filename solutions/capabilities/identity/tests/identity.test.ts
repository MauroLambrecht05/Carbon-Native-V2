import { describe, expect, test } from "bun:test";
import {
  CreateOrganizationUseCase,
  VerifyTokenUseCase,
  InMemoryIdentityRepository,
} from "../index.ts";

function harness() {
  const identity = new InMemoryIdentityRepository();
  return {
    create: new CreateOrganizationUseCase(identity),
    verify: new VerifyTokenUseCase(identity),
  };
}

describe("signup", () => {
  test("creates an org and a token that verifies to it", async () => {
    const h = harness();
    const { orgId, apiToken } = await h.create.execute("Acme");

    expect(orgId).toBeTruthy();
    expect(apiToken).toStartWith("cc_");

    expect(await h.verify.execute(apiToken)).toBe(orgId);
  });

  test("two orgs get different tokens, and one doesn't verify as the other", async () => {
    const h = harness();
    const a = await h.create.execute("Acme");
    const b = await h.create.execute("Beta");

    expect(a.apiToken).not.toBe(b.apiToken);
    expect(await h.verify.execute(a.apiToken)).toBe(a.orgId);
    expect(await h.verify.execute(b.apiToken)).toBe(b.orgId);
  });
});

describe("verification", () => {
  test("a garbage token verifies to null, not an error", async () => {
    const h = harness();
    expect(await h.verify.execute("not-a-real-token")).toBeNull();
  });

  test("an empty token verifies to null", async () => {
    const h = harness();
    expect(await h.verify.execute("")).toBeNull();
  });
});
