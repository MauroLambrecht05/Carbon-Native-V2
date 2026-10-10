import { PlatformFault, type ServiceError } from '@carbon/contracts/platform';
import type { ImportJobs, ImportTransport, ImportLease } from '../ports/ImportJobs.ts';

const safe = (error: unknown, work: ImportLease): ServiceError => ({ code: error instanceof PlatformFault ? error.code : 'unavailable',
  message: 'The import attempt could not complete; receipt reconciliation is required', requestId: work.requestId,
  ...(error instanceof PlatformFault && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}) });
export class RunImportJobs {
  constructor(private readonly jobs: ImportJobs, private readonly transport: ImportTransport) {}
  async execute(): Promise<boolean> {
    let work = await this.jobs.claim(); if (!work) return false; if (work === 'settled') return true;
    if (work.phase === 'reconcile') {
      try {
        const result = await this.transport.status(work);
        if (result) { await this.jobs.finish(work, result); return true; }
      } catch (error) {
        const fault = safe(error, work);
        if (fault.code === 'unavailable') await this.jobs.reconcile(work, fault, work.retryable); else await this.jobs.review(work, fault);
        return true;
      }
      const approved = await this.jobs.allowExecution(work); if (!approved) return true; work = approved;
    }
    try { await this.jobs.finish(work, await this.transport.execute(work)); }
    catch (error) { const fault = safe(error, work); await this.jobs.reconcile(work, fault, fault.code === 'unavailable'); }
    return true;
  }
}
