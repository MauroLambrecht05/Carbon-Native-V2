import type { ServiceAssertionVerifier } from '@carbon/identity';
import type { ServiceAuthority } from '../ports/ServiceAuthority.ts';

export class CheckServiceAuthority {
  constructor(private readonly verifiers: readonly ServiceAssertionVerifier[], private readonly authority: ServiceAuthority) {}
  async execute(token: string): Promise<boolean> {
    if (!token || token.length > 32768) return false;
    for (const verifier of this.verifiers) {
      let assertion; try { assertion = await verifier.inspect(token); } catch { continue; }
      return this.authority.isCurrent(assertion);
    }
    return false;
  }
}
