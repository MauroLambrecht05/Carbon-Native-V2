import { PlatformFault, parseComponent, type OperatorCommand, type OperatorOrganization, type OperatorReceipt, type OperatorRole } from '@carbon/contracts/platform';
import { randomBytes } from 'node:crypto';
import { tokenDigest } from './AccountAuthentication.ts';
import type { PostgresOperators } from '../../infrastructure/PostgresOperators.ts';

/**
 * What an operator can do with an operator credential. There is no impersonation here and no way to get one: an
 * operator credential opens nothing but this, and a customer credential does not open this.
 */
export class OperatorConsole {
  constructor(private readonly operators: PostgresOperators) {}

  private credential(authorization: string): string {
    const match = /^Bearer (op_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) throw new PlatformFault('unauthenticated', 'An operator credential is required');
    return tokenDigest(match[1]!);
  }
  async organization(authorization: string, orgId: string): Promise<OperatorOrganization> { return this.operators.organization(this.credential(authorization), parseComponent('Id', orgId)); }
  async execute(authorization: string, orgId: string, value: OperatorCommand, requestId: string): Promise<OperatorReceipt> {
    const tokenHash = this.credential(authorization); parseComponent('Id', orgId); parseComponent('Id', requestId);
    return this.operators.execute(tokenHash, orgId, parseComponent('OperatorCommand', value), requestId);
  }
  async actions(authorization: string, orgId: string) { return this.operators.actions(this.credential(authorization), parseComponent('Id', orgId)); }
}

/** Creating operators and their credentials. Run by whoever administers Cloud itself; no route leads here. */
export class OperatorAdministration {
  constructor(private readonly operators: PostgresOperators) {}
  async create(email: string, name: string, roles: readonly OperatorRole[]): Promise<string> {
    if (!/^[^@\s]+@[^@\s]+$/.test(email) || !name.trim() || !roles.length) throw new PlatformFault('validation', 'An operator needs an email address, a name and at least one role');
    return this.operators.create(email, name.trim(), roles.map(role => parseComponent('OperatorRole', role)));
  }
  /** Issues a credential and returns it once. Only its hash is stored. */
  async issue(operatorId: string, hours = 8): Promise<string> { const token = `op_${randomBytes(32).toString('base64url')}`; await this.operators.credential(parseComponent('Id', operatorId), tokenDigest(token), hours); return token; }
  async disable(operatorId: string): Promise<void> { await this.operators.disable(parseComponent('Id', operatorId)); }
}
