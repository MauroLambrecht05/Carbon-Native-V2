import type { FreshAuthBinding, SessionIssue } from "../../domain/entities/AccountIdentity.ts";
import type { ExternalAccountIdentity } from "./ExternalAccountProvider.ts";

export interface ExternalFlowStart {
  readonly id: string;
  readonly purpose: "registration" | "login" | "link";
  readonly stateHash: string;
  readonly browserHash: string;
  readonly protectedStart: string;
  readonly requestKey: string;
  readonly requestDigest: string;
  readonly requestId: string;
  readonly termsVersion: string;
  readonly redirectPath: string;
  readonly expiresAt: Date;
  readonly rateKeys: readonly string[];
  readonly binding?: FreshAuthBinding;
}
export interface ExternalFlowProof { readonly id: string; readonly purpose: 'login' | 'registration' | 'link'; readonly protectedIdentity: string }
export interface ExternalAccountRepository {
  start(input: ExternalFlowStart): Promise<{ id: string; protectedStart: string }>;
  claim(stateHash: string, browserHash: string): Promise<{ id: string; protectedStart: string }>;
  ready(id: string, browserHash: string, identity: ExternalAccountIdentity, protectedIdentity: string, completionHash: string): Promise<void>;
  fail(id: string): Promise<void>;
  proof(completionHash: string, browserHash: string): Promise<ExternalFlowProof>;
  complete(input: { readonly proof: ExternalFlowProof; readonly completionHash: string; readonly browserHash: string; readonly identity: ExternalAccountIdentity;
    readonly issue: SessionIssue; readonly binding?: FreshAuthBinding; readonly code?: string }): Promise<{ expiresAt: string; returnTo: string; linked: boolean }>;
}
