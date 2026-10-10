import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { assertionTrustFromEnv } from '../infrastructure/AssertionTrust.ts';
import { HttpAssertionAuthority } from '../infrastructure/HttpAssertionAuthority.ts';
import { assertion } from '../../../../contracts/platform/fixtures/conformance.ts';

test('assertion trust requires explicit enablement, bounded unique public keys, fixed algorithm and valid intervals', () => {
  expect(assertionTrustFromEnv({})).toBeUndefined();
  expect(() => assertionTrustFromEnv({ CARBON_INTERNAL_PLATFORM: 'yes' })).toThrow();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = { id: 'rotation-key', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' };
  const env = { CARBON_INTERNAL_PLATFORM: 'enabled', CARBON_ASSERTION_ISSUER: 'https://cloud.example.test', CARBON_ASSERTION_TRUST_KEYS: JSON.stringify([key]) };
  expect(assertionTrustFromEnv(env)!.keys).toHaveLength(1);
  for (const keys of [[], [key, key], [{ ...key, notAfter: key.notBefore }], [{ ...key, notAfter: 'tomorrow' }], [{ ...key, publicKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }], [{ ...key, revoked: 'false' }]]) {
    expect(() => assertionTrustFromEnv({ ...env, CARBON_ASSERTION_TRUST_KEYS: JSON.stringify(keys) })).toThrow('public keys');
  }
  expect(() => assertionTrustFromEnv({ ...env, CARBON_ASSERTION_ISSUER: 'http://untrusted.example.test' })).toThrow('secure origin');
});

test('HTTP authority forwards only the original proof to a pinned origin and rejects incomplete or oversized positive responses', async () => {
  for (const origin of ['http://remote.example.test', 'https://user:pass@cloud.example.test', 'https://cloud.example.test/path', 'https://cloud.example.test?redirect=elsewhere']) expect(() => new HttpAssertionAuthority(origin)).toThrow();
  let calls = 0;
  const positive = new HttpAssertionAuthority('https://cloud.example.test', (async (url, init) => {
    calls++; expect(String(url)).toBe('https://cloud.example.test/internal/platform/v1/authority');
    expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).get('authorization')).toBe('Bearer original-proof');
    expect(init?.body).toBe('{}'); return Response.json({ current: true });
  }) as typeof fetch);
  expect(await positive.isCurrent(assertion)).toBe(false); expect(calls).toBe(0);
  expect(await positive.isCurrent(assertion, 'original-proof')).toBe(true);
  for (const response of [Response.json({ current: true, extra: 'unexpected' }), Response.json({ current: 'true' }), Response.json({ current: false }),
    Response.json({ current: true }, { status: 503 }), new Response(' '.repeat(257) + '{"current":true}', { headers: { 'content-type': 'application/json' } })]) {
    const authority = new HttpAssertionAuthority('http://127.0.0.1:8080', (async (_input, _init) => response) as typeof fetch);
    expect(await authority.isCurrent(assertion, 'original-proof')).toBe(false);
  }
});
