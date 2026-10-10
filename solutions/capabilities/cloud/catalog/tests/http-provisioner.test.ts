import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { ServiceAssertionIssuer, ServiceAssertionVerifier, bodyDigest } from '@carbon/identity';
import { parseComponent, PlatformFault } from '@carbon/contracts/platform';
import { ids, principal, scope } from '../../../../contracts/platform/fixtures/conformance.ts';
import { HttpEnvironmentProvisioner } from '../infrastructure/HttpEnvironmentProvisioner.ts';
import type { ProvisioningWork } from '../application/ports/EnvironmentProvisioner.ts';

const keys = generateKeyPairSync('ed25519'); const now = Math.floor(Date.now() / 1000);
const key = { id: 'fixture-key', notBefore: now - 60, notAfter: now + 3600 };
const issuer = new ServiceAssertionIssuer('https://cloud.example.test', { ...key, key: keys.privateKey });
const work: ProvisioningWork = { operationId: ids.operation, stepId: ids.request, bindingId: ids.credential, leaseId: ids.account,
  scope, owner: 'database', action: 'ensure', principal, role: 'Owner', grants: [{ permission: 'resources.configure', scope }], remoteResourceId: null, requestId: ids.request };
const status = { scope, bindingId: work.bindingId, remoteResourceId: 'environment-resource', state: 'active' as const };

test('owning-service lifecycle transport signs exact canonical scope/body and keeps stable step idempotency across attempts', async () => {
  const claims: string[] = [];
  const verifier = new ServiceAssertionVerifier('https://cloud.example.test', 'carbon-database', [{ ...key, key: keys.publicKey }], { isCurrent: async () => true, consume: async () => true });
  const transport = (async (input, init) => {
    expect(String(input)).toBe(`https://database.example.test/internal/platform/v1/environments/${scope.environmentId}/lifecycle`);
    expect(init?.redirect).toBe('error'); const headers = new Headers(init?.headers);
    expect(headers.get('idempotency-key')).toBe(work.stepId);
    const command = parseComponent('ServiceLifecycleCommand', JSON.parse(String(init?.body))); expect(command.scope).toEqual(scope);
    const token = headers.get('authorization')!.slice(7); claims.push(token);
    const verified = await verifier.verify(token, { scope, permission: 'resources.configure', method: 'POST', path: new URL(String(input)).pathname,
      bodyDigest: bodyDigest(String(init?.body)), principalKinds: ['account'] });
    expect(verified.principal).toEqual(principal); expect(verified.requestId).toBe(work.requestId);
    return Response.json(status);
  }) as typeof fetch;
  const adapter = new HttpEnvironmentProvisioner('database', 'https://database.example.test', issuer, transport);
  expect(await adapter.apply(work, new AbortController().signal)).toEqual({ scope, remoteResourceId: status.remoteResourceId, state: status.state });
  await adapter.apply({ ...work, leaseId: crypto.randomUUID() }, new AbortController().signal);
  expect(claims[0]).not.toBe(claims[1]);
});

test('owning-service lifecycle transport rejects unsafe origins, oversized bodies, foreign bindings and unsanitized service failures', async () => {
  for (const url of ['http://database.example.test', 'https://user:pass@database.example.test', 'https://database.example.test/path', 'https://database.example.test?redirect=evil']) {
    expect(() => new HttpEnvironmentProvisioner('database', url, issuer)).toThrow();
  }
  for (const response of [Response.json({ ...status, bindingId: ids.org }), Response.json({ ...status, scope: { ...scope, orgId: ids.account } }),
    new Response('x'.repeat(32769), { headers: { 'content-type': 'application/json' } }), Response.json({ secret: 'provider secret' }, { status: 503 })]) {
    const adapter = new HttpEnvironmentProvisioner('database', 'http://127.0.0.1:54321', issuer, (async (_input, _init) => response) as typeof fetch);
    let failure: unknown; try { await adapter.apply(work, new AbortController().signal); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PlatformFault); expect(String(failure)).not.toContain('provider secret');
  }
});
