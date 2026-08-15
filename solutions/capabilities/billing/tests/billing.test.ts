import { describe, expect, test } from "bun:test";
import {
  RecordBuildUsageUseCase,
  CheckUsageLimitUseCase,
  UpgradePlanUseCase,
  ChargeFailedError,
  InMemoryBillingRepository,
  FakePaymentProvider,
  type PaymentProvider,
  type ChargeResult,
} from "../index.ts";

function harness() {
  const repo = new InMemoryBillingRepository();
  return {
    repo,
    record: new RecordBuildUsageUseCase(repo),
    check: new CheckUsageLimitUseCase(repo, repo),
    upgrade: new UpgradePlanUseCase(repo, new FakePaymentProvider()),
  };
}

describe("usage", () => {
  test("a free-plan org starts within limit", async () => {
    const h = harness();
    const status = await h.check.execute("org_1");
    expect(status.withinLimit).toBe(true);
    expect(status.usedMinutes).toBe(0);
    expect(status.includedMinutes).toBe(60);
  });

  test("recording usage accumulates minutes", async () => {
    const h = harness();
    await h.record.execute({ orgId: "org_1", buildId: "b1", durationMs: 5 * 60_000 });
    await h.record.execute({ orgId: "org_1", buildId: "b2", durationMs: 3 * 60_000 });
    const status = await h.check.execute("org_1");
    expect(status.usedMinutes).toBe(8);
  });

  test("usage past the free plan's included minutes trips the limit", async () => {
    const h = harness();
    await h.record.execute({ orgId: "org_1", buildId: "b1", durationMs: 61 * 60_000 });
    const status = await h.check.execute("org_1");
    expect(status.withinLimit).toBe(false);
  });

  test("usage is scoped per org", async () => {
    const h = harness();
    await h.record.execute({ orgId: "org_1", buildId: "b1", durationMs: 61 * 60_000 });
    const other = await h.check.execute("org_2");
    expect(other.withinLimit).toBe(true);
    expect(other.usedMinutes).toBe(0);
  });
});

describe("upgrade", () => {
  test("a successful charge changes the plan", async () => {
    const h = harness();
    await h.upgrade.execute("org_1", "pro");
    const status = await h.check.execute("org_1");
    expect(status.includedMinutes).toBe(6000);
  });

  test("a failed charge does not change the plan", async () => {
    const repo = new InMemoryBillingRepository();
    const decliningProvider: PaymentProvider = {
      async chargeForPlan(): Promise<ChargeResult> {
        return { success: false, reference: "declined" };
      },
    };
    const upgrade = new UpgradePlanUseCase(repo, decliningProvider);
    const check = new CheckUsageLimitUseCase(repo, repo);

    await expect(upgrade.execute("org_1", "pro")).rejects.toThrow(ChargeFailedError);
    const status = await check.execute("org_1");
    expect(status.includedMinutes).toBe(60); // still free
  });
});
