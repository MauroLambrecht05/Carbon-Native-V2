import { PlatformFault, parseComponent, type CommandOptions, type DataImportJobCreate, type DataImportJobCancel, type EnvironmentScope } from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type OrganizationActor } from '@carbon/identity';
import type { ImportJobs } from '../ports/ImportJobs.ts';

export class AccountImports {
  constructor(private readonly auth: AccountAuthentication, private readonly jobs: ImportJobs) {}
  private async actor(token: string, csrf: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to access imports');
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }
  private options(command: { commandId: string; revision: string }, options: CommandOptions) {
    parseComponent('CommandOptions', options);
    if (options.idempotencyKey.toLowerCase() !== command.commandId.toLowerCase() || options.expectedRevision !== command.revision)
      throw new PlatformFault('validation', 'Command identity and revision must match the headers');
  }
  async enqueue(token: string, csrf: string, scope: EnvironmentScope, input: DataImportJobCreate, options: CommandOptions, requestId: string) {
    const command = parseComponent('DataImportJobCreate', input); this.options(command, options);
    return this.jobs.enqueue(await this.actor(token, csrf), parseComponent('EnvironmentScope', scope), command, parseComponent('Id', requestId));
  }
  async get(token: string, csrf: string, scope: EnvironmentScope, id: string) {
    return this.jobs.get(await this.actor(token, csrf), parseComponent('EnvironmentScope', scope), parseComponent('Id', id));
  }
  async cancel(token: string, csrf: string, scope: EnvironmentScope, id: string, input: DataImportJobCancel, options: CommandOptions) {
    const command = parseComponent('DataImportJobCancel', input); this.options(command, options);
    return this.jobs.cancel(await this.actor(token, csrf), parseComponent('EnvironmentScope', scope), parseComponent('Id', id), command);
  }
}
