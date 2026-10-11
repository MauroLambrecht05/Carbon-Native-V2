// Environment secrets, environment credentials and organization workers as
// Carbon Cloud really offers them. A secret's value and a credential's token
// are write-once and read-never: nothing here returns either after the command
// that set or issued it.

import type { CommandOptions, Page, PageRequest, RequestContext, Result } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";

export type LiveSecret = Readonly<{ id: string; name: string; state: "active" | "disabled"; currentVersion: number; revision: string; createdAt: string; updatedAt: string }>;
export type LiveCredentialPermission = "metadata.read" | "resources.configure" | "data.read" | "data.write" | "release.publish";
export type LiveCredential = Readonly<{ id: string; name: string; prefix: string; permissions: readonly LiveCredentialPermission[]; status: "active" | "revoked"; expiresAt: string; revision: string; createdAt: string }>;
export type LiveWorker = Readonly<{
  id: string; name: string; purposes: readonly ("build" | "function")[]; status: string; platform: string | null; credentialExpiresAt: string | null; lastSeenAt: string | null; revision: string; createdAt: string;
}>;

export interface LiveConfigurationService {
  secrets(context: RequestContext, page?: PageRequest): Promise<Result<Page<LiveSecret>>>;
  /** `options.expectedRevision` is the environment's revision: creating a secret changes the environment. */
  createSecret(context: RequestContext, input: { name: string; value: string }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  rotateSecret(context: RequestContext, id: string, value: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  setSecretDisabled(context: RequestContext, id: string, disabled: boolean, options: CommandOptions): Promise<Result<CommandReceipt>>;
  credentials(context: RequestContext, page?: PageRequest): Promise<Result<Page<LiveCredential>>>;
  /** The receipt's `secretValue` is the credential, shown once. `options.expectedRevision` is the environment's revision. */
  createCredential(context: RequestContext, input: { name: string; permissions: readonly LiveCredentialPermission[]; expiresAt: string }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  /** Rotating returns the replacement in `secretValue`, once. The old value keeps working for `overlapSeconds`, then stops. */
  credentialCommand(context: RequestContext, id: string, command: { kind: "revoke" } | { kind: "rotate"; expiresAt: string; overlapSeconds: number }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  workers(context: RequestContext, page?: PageRequest): Promise<Result<Page<LiveWorker>>>;
  /** The receipt's `secretValue` is the enrollment code the worker machine is started with, shown once. */
  enrollWorker(context: RequestContext, input: { name: string; purposes: readonly ("build" | "function")[] }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  workerCommand(context: RequestContext, id: string, kind: "disable" | "enable" | "revoke", options: CommandOptions): Promise<Result<CommandReceipt>>;
}
