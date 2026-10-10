import { createPublicKey } from 'node:crypto';
import { parseComponent } from '@carbon/contracts/platform';
import type { AssertionKey } from './ServiceAssertions.ts';

export interface AssertionTrust { readonly issuer: string; readonly keys: readonly AssertionKey[] }
export function assertionTrustFromEnv(env: NodeJS.ProcessEnv = process.env): AssertionTrust | undefined {
  if (!env.CARBON_INTERNAL_PLATFORM || env.CARBON_INTERNAL_PLATFORM === 'disabled') return undefined;
  if (env.CARBON_INTERNAL_PLATFORM !== 'enabled') throw new Error('CARBON_INTERNAL_PLATFORM must be enabled or disabled');
  const issuer = env.CARBON_ASSERTION_ISSUER; if (!issuer) throw new Error('CARBON_ASSERTION_ISSUER is required');
  const url = new URL(issuer);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Assertion issuer must be a pinned secure origin');
  try {
    if (!env.CARBON_ASSERTION_TRUST_KEYS || env.CARBON_ASSERTION_TRUST_KEYS.length > 65536) throw new Error();
    const values = JSON.parse(env.CARBON_ASSERTION_TRUST_KEYS);
    if (!Array.isArray(values) || !values.length || values.length > 32) throw new Error();
    const ids = new Set<string>();
    const keys = values.map(value => {
      if (!value || Object.keys(value).some(k => !['id', 'publicKeyPem', 'notBefore', 'notAfter', 'revoked'].includes(k))
        || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) || ids.has(value.id)
        || typeof value.publicKeyPem !== 'string' || !value.publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----')
        || (value.revoked !== undefined && typeof value.revoked !== 'boolean')) throw new Error();
      ids.add(value.id); const key = createPublicKey(value.publicKeyPem); if (key.asymmetricKeyType !== 'ed25519') throw new Error();
      const notBefore = Date.parse(parseComponent('Timestamp', value.notBefore)) / 1000; const notAfter = Date.parse(parseComponent('Timestamp', value.notAfter)) / 1000;
      if (notAfter <= notBefore) throw new Error(); return { id: value.id, key, notBefore, notAfter, revoked: value.revoked };
    });
    return { issuer, keys };
  } catch { throw new Error('CARBON_ASSERTION_TRUST_KEYS must contain distinct Ed25519 public keys with UTC validity intervals'); }
}
