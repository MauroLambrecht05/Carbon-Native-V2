import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { HttpImportClient } from '../infrastructure/HttpImportClient.ts';
import { ServiceAssertionIssuer, ServiceAssertionVerifier, bodyDigest } from '@carbon/identity';
import { canonicalDataImportRequest, dataImportPath, type DataImportExecutionResult } from '@carbon/contracts/platform';
import type { ImportLease } from '../application/ports/ImportJobs.ts';
import { ids, scope, principal } from '../../../../contracts/platform/fixtures/conformance.ts';

const work: ImportLease = { request: { scope, bindingId: ids.credential, operationId: ids.operation, leaseId: ids.request,
  command: { kind: 'rows.import.apply', commandId: ids.account, tableId: ids.operation, revision: '1', access: { mode: 'policy-preview' },
    input: { format: 'json', text: '[{"body":"private source"}]', mapping: {}, conflict: 'error', atomic: true } } },
  principal, role: 'Owner', requestId: ids.request, phase: 'execute', cancelled: false, retryable: true, error: null };
const result: DataImportExecutionResult = { commandId: ids.account, tableId: ids.operation, revision: '1', total: 1, inserted: 1, updated: 0, skipped: 0, failed: 0, errors: [], errorsTruncated: false };
function signing() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const now = Date.now() / 1000;
  const key = { id: 'fixture', notBefore: now - 60, notAfter: now + 3600 };
  return { issuer: new ServiceAssertionIssuer('https://cloud.example.test', { ...key, key: privateKey }),
    verifier: new ServiceAssertionVerifier('https://cloud.example.test', 'carbon-database', [{ ...key, key: publicKey }], { isCurrent: async () => true, consume: async () => true }) };
}
const envelope = (value: unknown = result) => ({ scope, bindingId: work.request.bindingId, operationId: work.request.operationId, leaseId: work.request.leaseId, result: value });
const headers = { 'x-request-id': work.requestId };

test('import transport binds the lease, exact source, action and correlation to one signed authority grant', async () => {
  const { issuer, verifier } = signing(); let action: 'execute' | 'status' = 'execute';
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = dataImportPath(scope, work.request.bindingId, work.request.operationId, action); const sent = new Headers(init?.headers);
    expect(String(url)).toBe('https://database.example.test' + path); expect(init?.redirect).toBe('error');
    expect(init?.body).toBe(canonicalDataImportRequest(work.request)); expect(sent.get('x-request-id')).toBe(work.requestId);
    expect(sent.get('idempotency-key')).toBe(action === 'execute' ? work.request.command.commandId : null);
    const proof = await verifier.verify(sent.get('authorization')!.slice(7), { scope, permission: action === 'execute' ? 'data.write' : 'metadata.read',
      method: 'POST', path, bodyDigest: bodyDigest(String(init?.body)), principalKinds: ['account'] });
    expect(proof.requestId).toBe(work.requestId); expect(proof.grants).toHaveLength(1);
    return Response.json(envelope(action === 'execute' ? result : null), { headers });
  }) as typeof fetch;
  const client = new HttpImportClient('https://database.example.test', issuer, transport);
  expect(await client.execute(work)).toEqual(result); action = 'status'; expect(await client.status({ ...work, phase: 'reconcile' })).toBeNull();
  for (const origin of ['http://database.example.test', 'https://database.example.test/path', 'https://user:secret@database.example.test', 'https://database.example.test?x=1'])
    expect(() => new HttpImportClient(origin, issuer)).toThrow('pinned');
});

test('import transport rejects foreign leases, inconsistent receipts and malformed or oversized responses', async () => {
  const { issuer } = signing(); let response: () => Response = () => Response.json(envelope(), { headers });
  const client = new HttpImportClient('https://database.example.test', issuer, (async (_url: string | URL | Request, _init?: RequestInit) => response()) as typeof fetch);
  expect(await client.execute(work)).toEqual(result);
  for (const value of [
    { ...envelope(), leaseId: ids.account }, { ...envelope(), bindingId: ids.operation }, { ...envelope(), operationId: ids.account },
    { ...envelope(), scope: { ...scope, environmentId: ids.account } },
    ...[{ total: 0, inserted: 0 }, { total: 2 }, { revision: '2' }, { commandId: ids.request }, { inserted: 0, updated: 1 },
      { inserted: 0, skipped: 1 }, { errorsTruncated: true }, { inserted: 0, failed: 1, errors: [{ row: 1, code: 'invalid_value', message: 'Invalid' }] }].map(change => envelope({ ...result, ...change })),
  ]) {
    response = () => Response.json(value, { headers }); await expect(client.execute(work)).rejects.toThrow('Invalid import service response');
  }
  response = () => Response.json(envelope(null), { headers }); await expect(client.execute(work)).rejects.toThrow('Missing import execution result');
  response = () => Response.json(envelope(), { headers: { 'x-request-id': ids.account } }); await expect(client.execute(work)).rejects.toThrow('Invalid import service response');
  response = () => new Response('x'.repeat(131073), { headers: { ...headers, 'content-type': 'application/json' } }); await expect(client.status(work)).rejects.toThrow('Invalid import service response');
  response = () => new Response('malformed', { headers: { ...headers, 'content-type': 'application/json' } }); await expect(client.status(work)).rejects.toThrow('Invalid import service response');
});

test('import provider errors expose only the bounded row number and never source or SQL diagnostics', async () => {
  const { issuer } = signing(); const client = new HttpImportClient('https://database.example.test', issuer, (async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ error: {
    code: 'conflict', message: 'SQL contains private source', requestId: ids.request, fieldErrors: { row: '2', reason: 'secret constraint diagnostic' },
  } }, { status: 409, headers })) as typeof fetch);
  let failure: unknown; try { await client.execute(work); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'conflict', message: 'The import service rejected this request', fieldErrors: { row: '2' } });
  expect(JSON.stringify(failure)).not.toContain('secret'); expect(JSON.stringify(failure)).not.toContain('private source');
});
