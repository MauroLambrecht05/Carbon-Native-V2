import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  RecordBuildUsageUseCase,
  CheckUsageLimitUseCase,
  StartPlanUpgradeUseCase,
  ConfirmPlanUpgradeUseCase,
  InMemoryBillingRepository,
  FakeCheckoutSessionProvider,
  StripeCheckoutProvider,
  StripeApiError,
  NoPriceConfiguredError,
  verifyStripeWebhookSignature,
} from "../index.ts";

function harness() {
  const repo = new InMemoryBillingRepository();
  return {
    repo,
    record: new RecordBuildUsageUseCase(repo),
    check: new CheckUsageLimitUseCase(repo, repo),
    start: new StartPlanUpgradeUseCase(new FakeCheckoutSessionProvider()),
    confirm: new ConfirmPlanUpgradeUseCase(repo),
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
  test("starting an upgrade returns a redirect url and does not change the plan yet", async () => {
    const h = harness();
    const session = await h.start.execute("org_1", "pro", "https://app/ok", "https://app/cancel");
    expect(session.url).toContain("org_1");

    const status = await h.check.execute("org_1");
    expect(status.includedMinutes).toBe(60); // still free — nothing confirmed payment yet
  });

  test("confirming (as the webhook does once Stripe reports payment) changes the plan", async () => {
    const h = harness();
    await h.start.execute("org_1", "pro", "https://app/ok", "https://app/cancel");
    await h.confirm.execute("org_1", "pro");

    const status = await h.check.execute("org_1");
    expect(status.includedMinutes).toBe(6000);
  });

  test("a browser hitting successUrl without confirmation never upgrades anything", async () => {
    // The whole reason confirm is a separate step: a user can navigate to
    // successUrl (bookmark it, hit back/forward) without Stripe ever having
    // told us payment succeeded. Only an explicit confirm() call — which in
    // production only the webhook route makes, after signature
    // verification — changes the plan.
    const h = harness();
    await h.start.execute("org_1", "pro", "https://app/ok", "https://app/cancel");
    const status = await h.check.execute("org_1");
    expect(status.includedMinutes).toBe(60);
  });
});

describe("StripeCheckoutProvider", () => {
  function stubFetch(handler: (req: Request) => Response) {
    const original = globalThis.fetch;
    // @ts-expect-error — test-only stub, narrower than the real fetch overload set.
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      return handler(req);
    };
    return () => {
      globalThis.fetch = original;
    };
  }

  test("posts form-encoded fields Stripe's API expects and returns the session url", async () => {
    let seenAuth = "";
    const restore = stubFetch((req) => {
      seenAuth = req.headers.get("authorization") ?? "";
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/pay/cs_test_123" }), { status: 200 });
    });

    const provider = new StripeCheckoutProvider({
      secretKey: "sk_test_fake",
      priceIds: { pro: "price_123" },
    });
    const session = await provider.createSession("org_1", "pro", "https://app/ok", "https://app/cancel");

    expect(session.url).toBe("https://checkout.stripe.com/pay/cs_test_123");
    expect(seenAuth).toBe("Bearer sk_test_fake");
    restore();
  });

  test("the request body carries the fields Stripe's Checkout Sessions API expects", async () => {
    let capturedBody: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/pay/cs_test_123" }), { status: 200 });
    }) as typeof fetch;

    const provider = new StripeCheckoutProvider({ secretKey: "sk_test_fake", priceIds: { pro: "price_123" } });
    await provider.createSession("org_1", "pro", "https://app/ok", "https://app/cancel");

    expect(capturedBody).toContain("line_items%5B0%5D%5Bprice%5D=price_123");
    expect(capturedBody).toContain("metadata%5BorgId%5D=org_1");
    expect(capturedBody).toContain("metadata%5Bplan%5D=pro");
    expect(capturedBody).toContain("mode=subscription");
    globalThis.fetch = originalFetch;
  });

  test("a plan with no configured price id is refused before any network call", async () => {
    const provider = new StripeCheckoutProvider({ secretKey: "sk_test_fake", priceIds: {} });
    await expect(provider.createSession("org_1", "pro", "https://a", "https://b")).rejects.toThrow(
      NoPriceConfiguredError,
    );
  });

  test("a non-2xx Stripe response surfaces as StripeApiError, not a silent empty session", async () => {
    const restore = stubFetch(() => new Response("card_error", { status: 402 }));
    const provider = new StripeCheckoutProvider({ secretKey: "sk_test_fake", priceIds: { pro: "price_123" } });
    await expect(provider.createSession("org_1", "pro", "https://a", "https://b")).rejects.toThrow(StripeApiError);
    restore();
  });
});

describe("verifyStripeWebhookSignature", () => {
  const secret = "whsec_test_secret";

  function sign(payload: string, timestamp: number): string {
    const hmac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
    return `t=${timestamp},v1=${hmac}`;
  }

  test("accepts a correctly signed payload", () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const header = sign(payload, Math.floor(Date.now() / 1000));
    expect(verifyStripeWebhookSignature(payload, header, secret)).toBe(true);
  });

  test("rejects a tampered payload", () => {
    const header = sign(JSON.stringify({ amount: 100 }), Math.floor(Date.now() / 1000));
    const tampered = JSON.stringify({ amount: 999999 });
    expect(verifyStripeWebhookSignature(tampered, header, secret)).toBe(false);
  });

  test("rejects a signature made with the wrong secret", () => {
    const payload = JSON.stringify({ ok: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const wrongHmac = createHmac("sha256", "whsec_someone_elses_secret").update(`${timestamp}.${payload}`).digest("hex");
    expect(verifyStripeWebhookSignature(payload, `t=${timestamp},v1=${wrongHmac}`, secret)).toBe(false);
  });

  test("rejects a stale timestamp outside the replay tolerance", () => {
    const payload = JSON.stringify({ ok: true });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10_000; // way past the 300s default
    const header = sign(payload, staleTimestamp);
    expect(verifyStripeWebhookSignature(payload, header, secret)).toBe(false);
  });

  test("rejects a missing signature header", () => {
    expect(verifyStripeWebhookSignature("{}", null, secret)).toBe(false);
  });
});
