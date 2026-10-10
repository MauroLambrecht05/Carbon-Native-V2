import { createPrivateKey } from 'node:crypto';
import { ServiceAssertionIssuer } from '@carbon/identity';
import { parseComponent } from '@carbon/contracts/platform';

export function serviceAssertionIssuerFromEnv(env: NodeJS.ProcessEnv): ServiceAssertionIssuer {
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`Missing service signing configuration: ${name}`); return value; };
  const id = required('CARBON_ASSERTION_KEY_ID');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid assertion key identifier');
  const notBefore = Date.parse(parseComponent('Timestamp', required('CARBON_ASSERTION_KEY_NOT_BEFORE'))) / 1000;
  const notAfter = Date.parse(parseComponent('Timestamp', required('CARBON_ASSERTION_KEY_NOT_AFTER'))) / 1000;
  const now = Date.now() / 1000;
  if (notBefore > now || notAfter < now + 60) throw new Error('The assertion signing key must be active for at least the next minute');
  let key;
  try { key = createPrivateKey(required('CARBON_ASSERTION_PRIVATE_KEY')); if (key.asymmetricKeyType !== 'ed25519') throw new Error('Wrong algorithm'); }
  catch { throw new Error('Invalid service assertion signing configuration'); }
  return new ServiceAssertionIssuer(required('CARBON_PUBLIC_ORIGIN'), { id, key, notBefore, notAfter });
}
