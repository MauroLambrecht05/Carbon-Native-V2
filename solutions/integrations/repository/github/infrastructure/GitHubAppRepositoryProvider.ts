import { createHmac, createPrivateKey, createSign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { PlatformFault } from '@carbon/contracts/platform';
import type { ProviderProposalReceipt, ProviderRepository, RepositoryCommit, RepositoryInstallationSnapshot, RepositoryProposal, RepositoryProvider } from '@carbon/catalog';

function base64url(value: string | Uint8Array): string { return Buffer.from(value).toString('base64url'); }

export class GitHubAppRepositoryProvider implements RepositoryProvider {
  readonly provider = 'github' as const;
  private readonly key: KeyObject;

  constructor(private readonly appId: string, privateKey: string, private readonly webhookSecret: string,
    private readonly request: typeof fetch = fetch, private readonly now = () => new Date()) {
    if (!/^[1-9][0-9]{0,19}$/.test(appId) || !webhookSecret || Buffer.byteLength(webhookSecret) > 1024 || /[\u0000-\u001f\u007f]/.test(webhookSecret)) throw new Error('Invalid GitHub App configuration');
    try { this.key = createPrivateKey(privateKey); }
    catch { throw new Error('Invalid GitHub App private key'); }
    if (this.key.asymmetricKeyType !== 'rsa') throw new Error('GitHub App private key must be RSA');
  }

  private jwt(): string {
    const now = Math.floor(this.now().getTime() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }));
    const input = `${header}.${payload}`; const signer = createSign('RSA-SHA256'); signer.update(input); signer.end();
    return `${input}.${signer.sign(this.key).toString('base64url')}`;
  }

  private async requestJson(url: string, init: RequestInit, errorMessage: string, allowNotFound = false): Promise<Record<string, any> | readonly unknown[] | null> {
    try {
      const response = await this.request(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(15000) });
      if (allowNotFound && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new PlatformFault(response.status === 404 ? 'not_found' : response.status === 401 || response.status === 403 ? 'forbidden' : 'unavailable', errorMessage); }
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 1048576) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error();
      return parsed;
    } catch (error) {
      if (error instanceof PlatformFault) throw error;
      throw new PlatformFault('unavailable', errorMessage);
    }
  }
  private json(url: string, init: RequestInit, errorMessage: string) { return this.requestJson(url, init, errorMessage) as Promise<Record<string, any> | readonly unknown[]>; }

  private appHeaders() {
    return { accept: 'application/vnd.github+json', authorization: `Bearer ${this.jwt()}`, 'user-agent': 'Carbon-Repository', 'x-github-api-version': '2026-03-10' };
  }

  private installationId(value: string): string {
    if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new PlatformFault('validation', 'Invalid GitHub App installation identifier');
    return value;
  }
  private ref(value:string):string { if(value.length<1||value.length>255||/[\u0000-\u0020\u007f~^:?*[\\]/.test(value)||value.includes('..')||value.startsWith('/')||value.endsWith('/')||value.endsWith('.'))throw new PlatformFault('validation','Invalid repository ref');return value; }

  private async session(installationId: string) {
    installationId = this.installationId(installationId);
    const installation = await this.json(`https://api.github.com/app/installations/${installationId}`, { headers: this.appHeaders() }, 'GitHub installation access could not be verified') as Record<string, any>;
    if (String(installation.id) !== installationId || !installation.account || typeof installation.account !== 'object'
      || !Number.isSafeInteger(installation.account.id) || installation.account.id <= 0 || typeof installation.account.login !== 'string'
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(installation.account.login)
      || !['Organization', 'User'].includes(installation.target_type)) throw new PlatformFault('unavailable', 'GitHub returned an invalid installation');
    const tokenResult = await this.json(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: 'POST', headers: { ...this.appHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' } }),
    }, 'GitHub installation authorization is temporarily unavailable') as Record<string, any>;
    if (typeof tokenResult.token !== 'string' || tokenResult.token.length > 4096 || /[\u0000-\u0020\u007f]/.test(tokenResult.token)
      || typeof tokenResult.expires_at !== 'string' || Date.parse(tokenResult.expires_at) <= this.now().getTime()) throw new PlatformFault('unavailable', 'GitHub returned an invalid installation authorization');
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${tokenResult.token}`, 'user-agent': 'Carbon-Repository', 'x-github-api-version': '2026-03-10' };
    const repositories: ProviderRepository[] = []; let complete = false;
    for (let page = 1; page <= 10; page++) {
      const result = await this.json(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { headers }, 'GitHub repositories are temporarily unavailable') as Record<string, any>;
      if (!Array.isArray(result.repositories) || result.repositories.length > 100) throw new PlatformFault('unavailable', 'GitHub returned invalid repository metadata');
      for (const value of result.repositories) {
        if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.full_name !== 'string'
          || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value.full_name) || typeof value.default_branch !== 'string'
          || value.default_branch.length < 1 || value.default_branch.length > 255 || /[\u0000-\u001f\u007f]/.test(value.default_branch)
          || typeof value.private !== 'boolean' || typeof value.archived !== 'boolean') throw new PlatformFault('unavailable', 'GitHub returned invalid repository metadata');
        repositories.push({ id: String(value.id), fullName: value.full_name, defaultBranch: value.default_branch, private: value.private, archived: value.archived });
      }
      if (result.repositories.length < 100) { complete = true; break; }
    }
    if (!complete || repositories.length > 1000 || new Set(repositories.map(repository => repository.id)).size !== repositories.length) throw new PlatformFault('unavailable', 'GitHub returned too many or duplicate repositories');
    repositories.sort((a, b) => a.id.localeCompare(b.id));
    return { installationId, accountId: String(installation.account.id), account: installation.account.login,
      accountKind: installation.target_type === 'Organization' ? 'organization' as const : 'user' as const, repositories, headers };
  }

  async refresh(installationId: string): Promise<RepositoryInstallationSnapshot> {
    const { headers: _, ...snapshot } = await this.session(installationId); return snapshot;
  }

  async resolveCommit(installationId: string, repositoryId: string, ref: string): Promise<RepositoryCommit> {
    if (!/^[1-9][0-9]{0,19}$/.test(repositoryId)) throw new PlatformFault('validation', 'Invalid repository ref'); ref=this.ref(ref);
    const session = await this.session(installationId);
    if (!session.repositories.some(repository => repository.id === repositoryId && !repository.archived)) throw new PlatformFault('forbidden', 'The installation does not grant access to this repository');
    const commit = await this.json(`https://api.github.com/repositories/${repositoryId}/commits/${encodeURIComponent(ref)}`, { headers: session.headers }, 'GitHub could not resolve the repository ref') as Record<string, any>;
    if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new PlatformFault('unavailable', 'GitHub returned an invalid commit');
    return { repositoryId, requestedRef: ref, sha: commit.sha };
  }

  async createProposal(installationId: string, repositoryId: string, baseBranch: string, proposal: RepositoryProposal): Promise<ProviderProposalReceipt> {
    if (!/^[1-9][0-9]{0,19}$/.test(repositoryId) || !/^carbon\/proposal-[a-f0-9]{32}$/.test(proposal.branch)
      || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(proposal.path) || Buffer.byteLength(proposal.content, 'utf8') > 262144)
      throw new PlatformFault('validation', 'Invalid repository proposal');
    baseBranch=this.ref(baseBranch);
    const session = await this.session(installationId);
    if (!session.repositories.some(repository => repository.id === repositoryId && !repository.archived)) throw new PlatformFault('forbidden', 'The installation does not grant access to this repository');
    const repository = session.repositories.find(value => value.id === repositoryId && !value.archived);
    if (!repository) throw new PlatformFault('forbidden', 'The installation does not grant access to this repository');
    const base = await this.json(`https://api.github.com/repositories/${repositoryId}/commits/${encodeURIComponent(baseBranch)}`, { headers: session.headers }, 'GitHub could not resolve the proposal base') as Record<string, any>;
    if (typeof base.sha !== 'string' || !/^[a-f0-9]{40}$/.test(base.sha)) throw new PlatformFault('unavailable', 'GitHub returned an invalid proposal base');
    const refPath = `heads/${proposal.branch}`.split('/').map(encodeURIComponent).join('/');
    let ref = await this.requestJson(`https://api.github.com/repositories/${repositoryId}/git/ref/${refPath}`, { headers: session.headers }, 'GitHub could not inspect the proposal branch', true) as Record<string, any> | null;
    if (!ref) { await this.json(`https://api.github.com/repositories/${repositoryId}/git/refs`, { method: 'POST', headers: { ...session.headers, 'content-type': 'application/json' }, body: JSON.stringify({ ref: `refs/heads/${proposal.branch}`, sha: base.sha }) }, 'GitHub could not create the proposal branch'); ref = { object: { sha: base.sha } }; }
    if (typeof ref.object?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new PlatformFault('unavailable', 'GitHub returned an invalid proposal branch');
    const path = proposal.path.split('/').map(encodeURIComponent).join('/');
    const content = Buffer.from(proposal.content, 'utf8').toString('base64');
    const existing = await this.requestJson(`https://api.github.com/repositories/${repositoryId}/contents/${path}?ref=${encodeURIComponent(proposal.branch)}`, { headers: session.headers }, 'GitHub could not inspect the proposed file', true) as Record<string, any> | null;
    let headSha: string;
    if (existing && typeof existing.content === 'string' && existing.content.replace(/\s/g, '') === content) headSha = ref.object.sha;
    else {
      if (existing && (typeof existing.sha !== 'string' || !/^[a-f0-9]{40}$/.test(existing.sha))) throw new PlatformFault('unavailable', 'GitHub returned invalid proposed file metadata');
      const changed = await this.json(`https://api.github.com/repositories/${repositoryId}/contents/${path}`, { method: 'PUT', headers: { ...session.headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: proposal.message, content, branch: proposal.branch, ...(existing ? { sha: existing.sha } : {}) }) }, 'GitHub could not create the proposed change') as Record<string, any>;
      if (typeof changed.commit?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(changed.commit.sha)) throw new PlatformFault('unavailable', 'GitHub returned an invalid proposal commit'); headSha = changed.commit.sha;
    }
    const owner = repository.fullName.split('/')[0]!; const pulls = await this.json(`https://api.github.com/repositories/${repositoryId}/pulls?state=all&head=${encodeURIComponent(`${owner}:${proposal.branch}`)}`, { headers: session.headers }, 'GitHub could not inspect proposal pull requests') as readonly unknown[];
    let pull = pulls[0] as Record<string, any> | undefined;
    if (!pull) pull = await this.json(`https://api.github.com/repositories/${repositoryId}/pulls`, { method: 'POST', headers: { ...session.headers, 'content-type': 'application/json' }, body: JSON.stringify({ title: proposal.title, head: proposal.branch, base: baseBranch }) }, 'GitHub could not open the proposal pull request') as Record<string, any>;
    if (!Number.isSafeInteger(pull.number) || pull.number < 1 || typeof pull.html_url !== 'string' || !/^https:\/\/github[.]com\/[^ ]+$/.test(pull.html_url)) throw new PlatformFault('unavailable', 'GitHub returned an invalid pull request');
    return { pullRequestNumber: pull.number, url: pull.html_url, branch: proposal.branch, baseSha: base.sha, headSha };
  }

  verifyWebhook(rawBody: Uint8Array, signature: string, deliveryId: string, event: string): void {
    if (rawBody.byteLength > 1048576 || !/^[A-Za-z0-9-]{1,100}$/.test(deliveryId) || !/^[a-z][a-z0-9_]{0,63}$/.test(event)
      || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new PlatformFault('unauthenticated', 'Invalid GitHub webhook');
    const expected = Buffer.from(createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex'), 'hex');
    const actual = Buffer.from(signature.slice(7), 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new PlatformFault('unauthenticated', 'Invalid GitHub webhook');
  }
}
