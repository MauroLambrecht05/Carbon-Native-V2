import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { HttpDataClient } from '../infrastructure/HttpDataClient.ts';
import { ServiceAssertionIssuer, ServiceAssertionVerifier, bodyDigest } from '@carbon/identity';
import { canonicalDataRequest, dataRequestPath, type DataRequest, type DataResponse, type DataRow } from '@carbon/contracts/platform';
import { ids, scope, principal } from '../../../../contracts/platform/fixtures/conformance.ts';

test('row query responses cannot leak omitted columns or return unselected or repeated rows', async () => {
  const { privateKey } = generateKeyPairSync('ed25519'); const now = Date.now() / 1000;
  const issuer = new ServiceAssertionIssuer('https://cloud.example.test', { id: 'fixture', notBefore: now - 60, notAfter: now + 3600, key: privateKey });
  const row: DataRow = { id: ids.account, revision: '1', values: { body: 'value' } };
  let rows: typeof row[] = [row];
  const transport = (async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ scope, bindingId: ids.credential, result: { tableId: ids.operation, rows, nextAfterId: null } }, { headers: { 'x-request-id': ids.request } })) as typeof fetch;
  const client = new HttpDataClient('https://database.example.test', issuer, transport);
  const actor = { principal, role: 'Owner' as const, requestId: ids.request };
  const request: DataRequest = { scope, bindingId: ids.credential, command: { kind: 'rows.query', tableId: ids.operation, access: { mode: 'policy-preview' }, columns: ['body'], selectedIds: [ids.account] } };
  expect((await client.execute(request, actor)).result).toEqual({ tableId: ids.operation, rows, nextAfterId: null });
  rows = [{ ...row, values: { body: 'value', private: 'must not reach account' } } as typeof row];
  await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  rows = [{ ...row, id: ids.credential }]; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  rows = [row, row]; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
});

test('sorted query responses require complete matching boundaries without exposing omitted values', async () => {
  const { privateKey } = generateKeyPairSync('ed25519'); const now = Date.now() / 1000;
  const issuer = new ServiceAssertionIssuer('https://cloud.example.test', { id: 'fixture', notBefore: now - 60, notAfter: now + 3600, key: privateKey });
  const row = { id: ids.account, revision: '1', values: {} };
  const boundary = { value: 'sensitive sort value', sqlNull: false, revision: '1' };
  let result: DataResponse['result'] = { tableId: ids.operation, rows: [row], nextAfterId: row.id, nextSort: boundary };
  const transport = (async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ scope, bindingId: ids.credential, result }, { headers: { 'x-request-id': ids.request } })) as typeof fetch;
  const client = new HttpDataClient('https://database.example.test', issuer, transport);
  const actor = { principal, role: 'Owner' as const, requestId: ids.request };
  const request: DataRequest = { scope, bindingId: ids.credential, command: { kind: 'rows.query', tableId: ids.operation, access: { mode: 'policy-preview' }, columns: [], sort: { column: 'body', direction: 'asc' }, limit: 1 } };
  expect((await client.execute(request, actor)).result).toEqual(result);
  result = { tableId: ids.operation, rows: [row], nextAfterId: row.id }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  result = { ...result, nextSort: { ...boundary, sqlNull: true } }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  result = { tableId: ids.operation, rows: [row], nextAfterId: null, nextSort: boundary }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  const projected: DataRequest = { ...request, command: { ...request.command, columns: ['body'] } as Extract<DataRequest['command'], { kind: 'rows.query' }> };
  result = { tableId: ids.operation, rows: [{ ...row, values: { body: 'different' } }], nextAfterId: row.id, nextSort: boundary };
  await expect(client.execute(projected, actor)).rejects.toThrow('invalid response');
});

test('metadata transport signs read-only authority and rejects wrong tables, duplicate ordering and invalid continuations', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const now = Date.now() / 1000;
  const key = { id: 'fixture', notBefore: now - 60, notAfter: now + 3600 };
  const issuer = new ServiceAssertionIssuer('https://cloud.example.test', { ...key, key: privateKey });
  const verifier = new ServiceAssertionVerifier('https://cloud.example.test', 'carbon-database', [{ ...key, key: publicKey }], { isCurrent: async () => true, consume: async () => true });
  const summary = { id: ids.operation, revision: '1', name: 'notes', columnCount: 1, policiesEnabled: true };
  let result: DataResponse['result'] = { tables: [summary], nextAfterId: null };
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers); expect(headers.has('idempotency-key')).toBe(false);
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    await verifier.verify(headers.get('authorization')!.slice(7), { scope, permission: 'metadata.read', method: 'POST', path,
      bodyDigest: bodyDigest(String(init?.body)), principalKinds: ['account'] });
    return Response.json({ scope, bindingId: ids.credential, result }, { headers: { 'x-request-id': ids.request } });
  }) as typeof fetch;
  const client = new HttpDataClient('https://database.example.test', issuer, transport);
  const actor = { principal, role: 'Viewer' as const, requestId: ids.request };
  const request: DataRequest = { scope, bindingId: ids.credential, command: { kind: 'tables.list', limit: 2 } };
  expect((await client.execute(request, actor)).result).toEqual(result);
  result = { tables: [summary, summary], nextAfterId: null }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  result = { tables: [summary], nextAfterId: ids.operation }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  result = { tables: [summary], nextAfterId: null };
  await expect(client.execute({ ...request, command: { kind: 'tables.list', afterId: ids.operation } }, actor)).rejects.toThrow('invalid response');
  const named: DataRequest = { ...request, command: { kind: 'tables.list', sort: 'name', limit: 2 } };
  const alpha = { ...summary, id: ids.account, name: 'Alpha' };
  result = { tables: [alpha, summary], nextAfterId: summary.id, nextAfterName: summary.name };
  expect((await client.execute(named, actor)).result).toEqual(result);
  result = { ...result, nextAfterName: 'wrong' }; await expect(client.execute(named, actor)).rejects.toThrow('invalid response');
  result = { tables: [summary, alpha], nextAfterId: null }; await expect(client.execute(named, actor)).rejects.toThrow('invalid response');
  result = { tables: [summary], nextAfterId: null };
  await expect(client.execute({ ...named, command: { kind: 'tables.list', name: 'foreign' } }, actor)).rejects.toThrow('invalid response');
  await expect(client.execute({ ...named, command: { kind: 'tables.list', sort: 'name', afterId: ids.account } }, actor)).rejects.toThrow('continuation');
  const table = { id: ids.operation, revision: '1', definition: { name: 'notes', columns: [{ name: 'body', type: 'text' as const, nullable: false }], policies: { enabled: true, rules: [] } } };
  result = table;
  const details: DataRequest = { ...request, command: { kind: 'table.get', tableId: ids.operation } };
  expect((await client.execute(details, actor)).result).toEqual(table);
  result = { ...table, id: ids.account }; await expect(client.execute(details, actor)).rejects.toThrow('invalid response');
  const artifact = { tableId: ids.operation, revision: '1', language: 'typescript' as const, filename: 'notes-1.ts', contentType: 'text/plain' as const, text: 'export interface CarbonRowValues { body: string }\n' };
  const generated: DataRequest = { ...request, command: { kind: 'table.types', tableId: ids.operation, revision: '1' } };
  result = artifact; expect((await client.execute(generated, actor)).result).toEqual(artifact);
  result = { ...artifact, tableId: ids.account }; await expect(client.execute(generated, actor)).rejects.toThrow('invalid response');
  result = { ...artifact, revision: '2', filename: 'notes-2.ts' }; await expect(client.execute(generated, actor)).rejects.toThrow('invalid response');
  result = { ...artifact, filename: 'notes-2.ts' }; await expect(client.execute(generated, actor)).rejects.toThrow('invalid response');
  result = { ...artifact, filename: '../notes-1.ts' }; await expect(client.execute(generated, actor)).rejects.toThrow('invalid response');
  const importQuery: DataRequest = { ...request, command: { kind: 'rows.import-preview', tableId: ids.operation, revision: '1', input: { format: 'json', text: '[{"body":"text"},{}]', mapping: {}, conflict: 'error', atomic: true } } };
  const review = { tableId: ids.operation, revision: '1', validation: 'structure' as const, total: 2, valid: 1, invalid: 1,
    samples: [{ row: 1, values: { body: 'text' } }], errors: [{ row: 2, code: 'missing_column' as const, message: 'A required column is missing' }], errorsTruncated: false };
  result = review; expect((await client.execute(importQuery, actor)).result).toEqual(review);
  result = { ...review, tableId: ids.account }; await expect(client.execute(importQuery, actor)).rejects.toThrow('invalid response');
  result = { ...review, revision: '2' }; await expect(client.execute(importQuery, actor)).rejects.toThrow('invalid response');
  result = { ...review, total: 3 }; await expect(client.execute(importQuery, actor)).rejects.toThrow('invalid response');
  result = { ...review, samples: [] }; await expect(client.execute(importQuery, actor)).rejects.toThrow('invalid response');
  result = { ...review, errors: [{ ...review.errors[0]!, row: 1 }] }; await expect(client.execute(importQuery, actor)).rejects.toThrow('invalid response');
  result = { ...review, errors: [{ ...review.errors[0]!, row: 3 }] }; await expect(client.execute(importQuery, actor)).rejects.toThrow('invalid response');
  result = { ...review, errorsTruncated: true }; await expect(client.execute(importQuery, actor)).rejects.toThrow('invalid response');
});

test('data transport binds requests and rejects foreign responses, oversized bodies and provider diagnostics', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const now = Date.now() / 1000;
  const key = { id: 'fixture', notBefore: now - 60, notAfter: now + 3600 };
  const issuer = new ServiceAssertionIssuer('https://cloud.example.test', { ...key, key: privateKey });
  const verifier = new ServiceAssertionVerifier('https://cloud.example.test', 'carbon-database', [{ ...key, key: publicKey }], { isCurrent: async () => true, consume: async () => true });
  const request: DataRequest = { scope, bindingId: ids.credential, command: { kind: 'rows.query', tableId: ids.operation, access: { mode: 'policy-preview' }, limit: 1 } };
  const actor = { principal, role: 'Owner' as const, requestId: ids.request };
  let response: DataResponse = { scope, bindingId: ids.credential, result: { tableId: ids.operation, rows: [], nextAfterId: null } };
  let mode = 'valid';
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://database.example.test' + dataRequestPath(scope, ids.credential, 'rows.query'));
    expect(init?.redirect).toBe('error'); expect(init?.body).toBe(canonicalDataRequest(request));
    const headers = new Headers(init?.headers); expect(headers.has('idempotency-key')).toBe(false);
    const proof = await verifier.verify(headers.get('authorization')!.slice(7), { scope, permission: 'data.read', method: 'POST',
      path: dataRequestPath(scope, ids.credential, 'rows.query'), bodyDigest: bodyDigest(String(init?.body)), principalKinds: ['account'] });
    expect(proof.requestId).toBe(ids.request);
    if (mode === 'provider') return new Response('private-provider-diagnostic', { status: 503 });
    if (mode === 'oversize') return new Response(' '.repeat(2179073), { headers: { 'content-type': 'application/json', 'x-request-id': ids.request } });
    return Response.json(response, { headers: { 'x-request-id': mode === 'correlation' ? ids.account : ids.request } });
  }) as typeof fetch;
  const client = new HttpDataClient('https://database.example.test', issuer, transport);
  expect(await client.execute(request, actor)).toEqual(response);
  response = { ...response, scope: { ...scope, environmentId: ids.account } }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  response = { ...response, scope, bindingId: ids.account }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  response = { scope, bindingId: ids.credential, result: { tableId: ids.account, rows: [], nextAfterId: null } }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  response = { ...response, result: { tableId: ids.operation, rows: [], nextAfterId: ids.account } }; await expect(client.execute(request, actor)).rejects.toThrow('invalid response');
  for (const failure of ['correlation','oversize','provider']) {
    mode = failure;
    try { await client.execute(request, actor); throw new Error('Expected rejection'); }
    catch (error) { expect(String(error)).not.toContain('private-provider-diagnostic'); expect(String(error)).toContain('data service'); }
  }
  for (const origin of ['http://database.example.test','https://user:secret@example.test','https://example.test/path','https://example.test?key=x']) expect(() => new HttpDataClient(origin, issuer)).toThrow();
});
