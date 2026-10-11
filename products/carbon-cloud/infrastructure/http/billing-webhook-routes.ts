import { PlatformFault } from '@carbon/contracts/platform';
import type { BillingWebhooks } from '@carbon/billing';

const MAX_BYTES = 262144;

/**
 * Where the payment provider delivers events: `POST /billing/v1/webhooks/stripe`. The signature over the exact bytes
 * received is the only credential. A duplicate delivery answers 200 like the first, so the provider stops retrying.
 */
export function createBillingWebhookRoutes(webhooks: BillingWebhooks) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID(); const headers = { 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/billing/v1/webhooks/stripe' || url.search || request.method !== 'POST') throw new PlatformFault('not_found', 'Route not found');
      const reader = request.body?.getReader(); if (!reader) throw new PlatformFault('validation', 'A request body is required');
      const chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_BYTES) throw new PlatformFault('validation', 'Request body exceeds the limit'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      // The bytes are verified exactly as they arrived: re-encoding them would change what was signed.
      const outcome = await webhooks.receive(Buffer.concat(chunks).toString('utf8'), request.headers.get('stripe-signature'), requestId);
      return Response.json({ received: true, outcome }, { headers });
    } catch (error) {
      const fault = error instanceof PlatformFault ? error : new PlatformFault('unavailable', 'The event could not be processed');
      // Anything but a refusal is answered 503, so the provider delivers the event again.
      const status = { unauthenticated: 401, validation: 400, not_found: 404 }[fault.code as 'unauthenticated'] ?? 503;
      return Response.json({ error: { code: fault.code, message: fault.message, requestId } }, { status, headers });
    }
  };
}
