import type { Account, Invitation, Notification, Transfer } from "../../../presentation/framework/services/identity-contracts";
import type { MockState } from "./store";
import { now } from "./clock";

export interface IdentityState {
  accounts: Record<string, Account & { recoveryCodes: string[]; enrollment?: string; githubEmail?: string }>;
  challenges: Record<string, { id: string; token: string; accountId: string; email: string; purpose: string; returnTo: string; expiresAt: string; used: boolean; createdAt: string }>;
  invitations: Record<string, Invitation & { token: string }>;
  organizations: Record<string, { namespace: string; billingContact: string; requireMfa: boolean; entitlement: "free" }>;
  transfers: Record<string, Transfer>;
  notifications: Record<string, Notification>;
  sessionDetails: Record<string, { createdAt: string; lastActivityAt: string; authenticatedAt: string; mfa: boolean }>;
  accountAudit: Record<string, { id: string; accountId: string; action: string; at: string; requestId: string }>;
  supportCases: Record<string, { id: string; email: string; status: "pending" }>;
  nextProvisionFailure: boolean;
}
// Additive schema-v1 extension: keep completed Slice 1 workspaces intact.
export function identityState(state: MockState): IdentityState {
  if (!state.identity) state.identity = {
    accounts: {}, challenges: {}, invitations: {}, organizations: {}, transfers: {},
    notifications: {}, sessionDetails: {}, accountAudit: {}, supportCases: {}, nextProvisionFailure: false,
  };
  const data = state.identity;
  for (const account of Object.values(state.accounts)) if (!data.accounts[account.id]) data.accounts[account.id] = {
    ...account, email: `${account.id}@example.test`, avatar: "", revision: "r1", status: "active",
    termsVersion: "mock-2026-09", verifiedAt: "2026-09-06T12:00:00.000Z", methods: ["email"],
    mfa: false, recoveryCodesRemaining: 0, recoveryCodes: [], notifications: true,
  };
  for (const org of Object.values(state.organizations)) data.organizations[org.id] ??= {
    namespace: org.id.replaceAll("_", "-"), billingContact: "owner@example.test", requireMfa: false, entitlement: "free",
  };
  for (const session of Object.values(state.sessions)) data.sessionDetails[session.id] ??= {
    createdAt: new Date(Date.parse(session.expiresAt) - 3_600_000).toISOString(),
    authenticatedAt: new Date(Date.parse(session.expiresAt) - 3_600_000).toISOString(),
    lastActivityAt: new Date(Date.parse(session.expiresAt) - 3_600_000).toISOString(), mfa: false,
  };
  return data;
}
export function reconcileIdentity(state: MockState, wall: number): boolean {
  const initial = !state.identity;
  const data = identityState(state);
  let changed = initial;
  for (const invite of Object.values(data.invitations)) if (invite.status === "pending" && Date.parse(invite.expiresAt) <= now(state.clock, wall)) {
    data.invitations[invite.id] = { ...invite, status: "expired", revision: bump(invite.revision) };
    changed = true;
  }
  return changed;
}
export const bump = (revision: string) => `r${Number(revision.slice(1)) + 1}`;
export const allocate = (state: MockState, prefix: string) => `${prefix}_${String(state.nextId++).padStart(8, "0")}`;
