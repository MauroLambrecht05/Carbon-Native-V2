import type {
  EnvironmentScope, Worker, WorkerCapabilities, WorkerCommand, WorkerCredentialIssue, WorkerEnrollmentIssue, WorkerLease, WorkerLeaseOffer,
  WorkerLeaseReceipt, WorkerPurpose, WorkerReceipt, WorkerSecretBindings,
} from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';

export interface WorkerCredentialSecret { readonly token: string; readonly tokenHash: string; readonly tokenPrefix: string; readonly credentialExpiresAt: Date }
export interface WorkerEnrollmentInput {
  readonly actor: OrganizationActor; readonly orgId: string; readonly id: string; readonly name: string; readonly purposes: readonly WorkerPurpose[];
  readonly code: string; readonly codeHash: string; readonly expiresAt: Date; readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}
export interface WorkerMutation {
  readonly actor: OrganizationActor; readonly orgId: string; readonly workerId: string; readonly command: WorkerCommand;
  readonly expectedRevision: string; readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}
export interface WorkerEnrollInput extends WorkerCredentialSecret { readonly codeHash: string; readonly capabilities: WorkerCapabilities; readonly requestId: string }
export interface WorkerRotateInput extends WorkerCredentialSecret { readonly currentTokenHash: string; readonly requestId: string }
export interface WorkerClaimInput { readonly tokenHash: string; readonly leaseToken: string; readonly leaseTokenHash: string; readonly requestId: string }
export interface WorkerLeaseInput { readonly tokenHash: string; readonly leaseId: string; readonly leaseTokenHash: string; readonly requestId: string }
export interface WorkerLeaseGrant {
  readonly id: string; readonly scope: EnvironmentScope; readonly purpose: WorkerPurpose; readonly subjectId: string; readonly secretNames: readonly string[];
  readonly requiredPlatform?: WorkerCapabilities['platform']; readonly claimSeconds: number; readonly deadlineSeconds: number; readonly maxAttempts: number; readonly requestId: string;
}

export interface WorkerRepository {
  // Organization managers, through the browser session.
  list(actor: OrganizationActor, orgId: string, limit: number, afterId?: string): Promise<readonly Worker[]>;
  createEnrollment(input: WorkerEnrollmentInput): Promise<WorkerEnrollmentIssue>;
  execute(input: WorkerMutation): Promise<WorkerReceipt>;
  // The worker itself.
  enroll(input: WorkerEnrollInput): Promise<WorkerCredentialIssue>;
  rotate(input: WorkerRotateInput): Promise<WorkerCredentialIssue>;
  claim(input: WorkerClaimInput): Promise<WorkerLeaseOffer>;
  heartbeat(input: WorkerLeaseInput): Promise<WorkerLeaseReceipt>;
  complete(input: WorkerLeaseInput): Promise<WorkerLeaseReceipt>;
  materialize(input: WorkerLeaseInput): Promise<WorkerSecretBindings>;
  // Trusted orchestration inside Cloud. No HTTP route reaches these.
  grant(input: WorkerLeaseGrant): Promise<WorkerLease>;
  cancel(subjectId: string, requestId: string): Promise<readonly WorkerLease[]>;
  reclaim(requestId: string, limit: number): Promise<readonly WorkerLease[]>;
}
