// Verifies a `Stripe-Signature` header against Stripe's own documented
// algorithm (https://docs.stripe.com/webhooks#verify-manually) — this is
// what stands between "a completed Checkout Session really happened" and
// "anyone who finds the webhook URL can POST a fake one and grant
// themselves the pro plan for free". Reimplemented by hand rather than
// pulled from the `stripe` npm SDK for the same no-heavy-SDK reason
// StripeCheckoutProvider gives; the algorithm itself is small and stable.
//
// Header shape: `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]` — more
// than one v1 entry appears during Stripe's own secret rotation, and the
// signature is valid if ANY of them match.

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300; // Stripe's own default replay window.

export function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  webhookSecret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(",").map((p) => p.split("="));
  const timestamp = parts.find(([k]) => k === "t")?.[1];
  const candidates = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || candidates.length === 0) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > toleranceSeconds) return false;

  const expected = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");

  return candidates.some((candidate) => {
    if (!candidate || candidate.length !== expected.length) return false;
    const candidateBuf = Buffer.from(candidate, "hex");
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
  });
}
