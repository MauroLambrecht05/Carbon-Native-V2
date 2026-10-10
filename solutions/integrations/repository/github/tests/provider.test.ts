import { describe, expect, test } from 'bun:test';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { GitHubAppRepositoryProvider } from '../infrastructure/GitHubAppRepositoryProvider.ts';

const now = new Date('2026-09-13T12:00:00.000Z');

function harness(options: { archived?: boolean; providerFailure?: boolean } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls: { url: string; init: RequestInit }[] = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init: init! });
    if (options.providerFailure) return Response.json({ message: 'ghs_provider_secret must stay private' }, { status: 503 });
    if (url.endsWith('/app/installations/42')) return Response.json({ id: 42, target_type: 'Organization', account: { id: 77, login: 'carbon-team' } });
    if (url.endsWith('/app/installations/42/access_tokens')) return Response.json({ token: 'ghs_installation_secret', expires_at: '2026-09-13T13:00:00.000Z' });
    if (url.includes('/installation/repositories')) return Response.json({ total_count: 1, repositories: [{ id: 99, full_name: 'carbon-team/desktop', default_branch: 'main', private: true, archived: options.archived ?? false }] });
    if (url.endsWith('/repositories/99/commits/release%2Fv1')) return Response.json({ sha: 'a'.repeat(40) });
    if (url.endsWith('/repositories/99/commits/main')) return Response.json({ sha: 'a'.repeat(40) });
    if (url.includes('/repositories/99/git/ref/heads/carbon/proposal-')) return calls.some(call => call.url.endsWith('/repositories/99/git/refs') && call.init.method === 'POST') ? Response.json({ object: { sha: 'b'.repeat(40) } }) : Response.json({}, { status: 404 });
    if (url.endsWith('/repositories/99/git/refs')) return Response.json({ ref: 'refs/heads/carbon/proposal-' + '1'.repeat(32) });
    if (url.includes('/repositories/99/contents/carbon/app.json?ref=')) return calls.some(call => call.url.endsWith('/repositories/99/contents/carbon/app.json') && call.init.method === 'PUT') ? Response.json({ sha: 'e'.repeat(40), content: 'e30=' }) : Response.json({ sha: 'd'.repeat(40), content: Buffer.from('old').toString('base64') });
    if (url.endsWith('/repositories/99/contents/carbon/app.json')) return Response.json({ commit: { sha: 'b'.repeat(40) } });
    if (url.includes('/repositories/99/pulls?')) return Response.json(calls.some(call => call.url.endsWith('/repositories/99/pulls') && call.init.method === 'POST') ? [{ number: 12, html_url: 'https://github.com/carbon-team/desktop/pull/12' }] : []);
    if (url.endsWith('/repositories/99/pulls')) return Response.json({ number: 12, html_url: 'https://github.com/carbon-team/desktop/pull/12' });
    return Response.json({ message: 'unexpected' }, { status: 404 });
  }) as typeof fetch;
  return { provider: new GitHubAppRepositoryProvider('1234', pem, 'webhook-secret', request, () => now), calls, publicKey };
}

describe('GitHub App repository provider', () => {
  test('uses signed app JWTs and ephemeral installation tokens for bounded repository discovery', async () => {
    const h = harness(); const snapshot = await h.provider.refresh('42');
    expect(snapshot).toEqual({ installationId: '42', accountId: '77', account: 'carbon-team', accountKind: 'organization',
      repositories: [{ id: '99', fullName: 'carbon-team/desktop', defaultBranch: 'main', private: true, archived: false }] });
    expect(h.calls.map(call => call.url)).toEqual([
      'https://api.github.com/app/installations/42',
      'https://api.github.com/app/installations/42/access_tokens',
      'https://api.github.com/installation/repositories?per_page=100&page=1',
    ]);
    const appAuthorization = new Headers(h.calls[0]!.init.headers).get('authorization')!;
    const jwt = appAuthorization.slice('Bearer '.length); const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ iat: 1789300740, exp: 1789301340, iss: '1234' });
    const verifier = createVerify('RSA-SHA256'); verifier.update(`${header}.${payload}`); verifier.end();
    expect(verifier.verify(h.publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(new Headers(h.calls[1]!.init.headers).get('authorization')).toStartWith('Bearer ey');
    expect(new Headers(h.calls[2]!.init.headers).get('authorization')).toBe('Bearer ghs_installation_secret');
    expect(JSON.stringify(snapshot)).not.toContain('ghs_');
  });

  test('revalidates installation repository access and resolves a ref to one immutable SHA', async () => {
    const h = harness();
    expect(await h.provider.resolveCommit('42', '99', 'release/v1')).toEqual({ repositoryId: '99', requestedRef: 'release/v1', sha: 'a'.repeat(40) });
    expect(h.calls.at(-1)!.url).toBe('https://api.github.com/repositories/99/commits/release%2Fv1');
    await expect(h.provider.resolveCommit('42', '100', 'main')).rejects.toThrow('does not grant access');
    await expect(harness({ archived: true }).provider.resolveCommit('42', '99', 'main')).rejects.toThrow('does not grant access');
    for (const ref of ['', '../main', 'refs heads/main', 'main~1', '/main', 'main.']) await expect(h.provider.resolveCommit('42', '99', ref)).rejects.toThrow('Invalid repository ref');
  });

  test('authenticates exact raw webhook bytes and rejects forged metadata without leaking provider bodies', async () => {
    const h = harness(); const raw = Buffer.from('{"installation":{"id":42}}');
    const signature = 'sha256=' + createHmac('sha256', 'webhook-secret').update(raw).digest('hex');
    expect(() => h.provider.verifyWebhook(raw, signature, 'delivery-123', 'installation')).not.toThrow();
    for (const values of [
      [raw, 'sha256=' + '0'.repeat(64), 'delivery-123', 'installation'],
      [raw, signature, 'bad delivery', 'installation'],
      [raw, signature, 'delivery-123', 'Bad/Event'],
      [Buffer.alloc(1048577), signature, 'delivery-123', 'installation'],
    ] as const) expect(() => h.provider.verifyWebhook(values[0], values[1], values[2], values[3])).toThrow('Invalid GitHub webhook');
    const failing = harness({ providerFailure: true });
    let error: unknown; try { await failing.provider.refresh('42'); } catch (value) { error = value; }
    expect(String(error)).toContain('could not be verified'); expect(String(error)).not.toContain('provider_secret');
  });

  test('creates dashboard changes on an isolated branch and opens a pull request', async () => {
    const h=harness(); const branch='carbon/proposal-'+'1'.repeat(32);
    const receipt=await h.provider.createProposal('42','99','main',{path:'carbon/app.json',content:'{}',title:'Update Carbon app',message:'Update Carbon app configuration',branch});
    expect(receipt).toEqual({pullRequestNumber:12,url:'https://github.com/carbon-team/desktop/pull/12',branch,baseSha:'a'.repeat(40),headSha:'b'.repeat(40)});
    const writes=h.calls.filter(call=>['POST','PUT'].includes(call.init.method??'GET')).slice(1);
    expect(writes.map(call=>[call.init.method,call.url])).toEqual([
      ['POST','https://api.github.com/repositories/99/git/refs'],['PUT','https://api.github.com/repositories/99/contents/carbon/app.json'],['POST','https://api.github.com/repositories/99/pulls'],
    ]);
    expect(JSON.parse(String(writes[0]!.init.body)).ref).toBe(`refs/heads/${branch}`);
    expect(JSON.parse(String(writes[1]!.init.body))).toEqual({message:'Update Carbon app configuration',content:'e30=',branch,sha:'d'.repeat(40)});
    expect(await h.provider.createProposal('42','99','main',{path:'carbon/app.json',content:'{}',title:'Update Carbon app',message:'Update Carbon app configuration',branch})).toEqual(receipt);
    expect(h.calls.filter(call=>call.url.endsWith('/repositories/99/git/refs')&&call.init.method==='POST')).toHaveLength(1);
    expect(h.calls.filter(call=>call.url.endsWith('/repositories/99/contents/carbon/app.json')&&call.init.method==='PUT')).toHaveLength(1);
    expect(h.calls.filter(call=>call.url.endsWith('/repositories/99/pulls')&&call.init.method==='POST')).toHaveLength(1);
  });

  test('rejects non-RSA app keys and incomplete app/webhook configuration', () => {
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => new GitHubAppRepositoryProvider('1234', ed, 'secret')).toThrow('must be RSA');
    expect(() => new GitHubAppRepositoryProvider('0', 'invalid', '')).toThrow('Invalid GitHub App configuration');
  });
});
