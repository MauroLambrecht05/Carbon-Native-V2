import type { CommandOptions, Result, Scope } from "../../../presentation/framework/services/contracts";
import type { Account, CommandReceipt, IdentityService } from "../../../presentation/framework/services/identity-contracts";
import { safeReturn } from "../../../presentation/framework/routing/routes";
import { requireSession, Refusal } from "./access";
import { now } from "./clock";
import { allocate, bump, identityState } from "./identity-state";
import { paginate } from "./pagination";
import type { MockState } from "./store";

export type Run = <T>(execute: (state: MockState, requestId: string) => T, config?: { signal?: AbortSignal; mutate?: boolean; fast?: boolean; audit?: { scope: Scope; action: string; resourceId?: string } }) => Promise<Result<T>>;
export const emailAddress = (email: string) => {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) throw new Refusal("validation", "Enter a valid email address.");
  return value;
};
export const requiredName = (name: string) => {
  if (!name.trim() || name.trim().length > 80) throw new Refusal("validation", "Name must contain 1–80 characters.");
  return name.trim();
};
export function revision(actual: string, options: CommandOptions) {
  if (actual !== options.expectedRevision) throw new Refusal("conflict", "This record changed. Reload and compare before submitting again.");
}
export function once<T>(state: MockState, actor: string, scope: Scope | undefined, input: unknown, options: CommandOptions, execute: () => T): T {
  if (!options.idempotencyKey?.trim() || options.idempotencyKey.length > 200) throw new Refusal("validation", "An idempotency key of 1–200 characters is required.");
  const key = JSON.stringify([actor, scope ?? null, "identity-platform", options.idempotencyKey]);
  const fingerprint = JSON.stringify([input, options.expectedRevision]);
  const existing = state.idempotency[key];
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Refusal("conflict", "This idempotency key was used with different input.");
    return structuredClone(existing.value) as T;
  }
  const value = execute();
  // A one-time secret is never recoverable from the command replay store.
  const saved = structuredClone(value) as T & { recoveryCodes?: readonly string[] };
  if (saved && typeof saved === "object") delete saved.recoveryCodes;
  state.idempotency[key] = { fingerprint, value: saved };
  return value;
}
export function accountFor(state: MockState, wall: number) {
  const session = requireSession(state, wall);
  const account = identityState(state).accounts[session.accountId];
  if (!account || account.status !== "active") throw new Refusal("unauthenticated", "An active verified Carbon account is required.");
  return account;
}
export function fresh(state: MockState, wall: number) {
  const session = requireSession(state, wall);
  const details = identityState(state).sessionDetails[session.id];
  if (!details || now(state.clock, wall) - Date.parse(details.authenticatedAt) > 300_000) throw new Refusal("unauthenticated", "Fresh authentication required. Sign in again within five simulated minutes, then resubmit.");
  if (identityState(state).accounts[session.accountId]?.mfa && !details.mfa)
    throw new Refusal("unauthenticated", "MFA was enabled after this session began. Sign in with MFA before changing security-sensitive settings.");
}
export function accountAudit(state: MockState, accountId: string, action: string, requestId: string, time: number) {
  const data = identityState(state), id = allocate(state, "account-audit");
  data.accountAudit[id] = { id, accountId, action, at: new Date(time).toISOString(), requestId };
}
export function notifyAccount(state: MockState, accountId: string, name: string, href: string, time: number) {
  const data = identityState(state), id = allocate(state, "notification");
  data.notifications[id] = { id, accountId, name, href, read: false, createdAt: new Date(time).toISOString() };
}
export function challenge(state: MockState, accountId: string, email: string, purpose: string, returnTo: string, time: number) {
  const data = identityState(state);
  for (const entry of Object.values(data.challenges)) if (entry.accountId === accountId && entry.purpose === purpose) entry.used = true;
  const id = allocate(state, "challenge");
  data.challenges[id] = { id, token: crypto.randomUUID(), accountId, email, purpose, returnTo: safeReturn(returnTo), expiresAt: new Date(time + 900_000).toISOString(), used: false, createdAt: new Date(time).toISOString() };
}
export function mfaCode(accountId: string) { return String([...accountId].reduce((sum, c) => sum + c.charCodeAt(0), 100_000)).padStart(6, "0"); }
function verifyMfa(state: MockState, accountId: string, code: string | undefined) {
  const account = identityState(state).accounts[accountId];
  if (code === mfaCode(accountId)) return;
  const index = account.recoveryCodes.indexOf(code ?? "");
  if (index < 0) throw new Refusal("validation", "Enter the mock authenticator code or an unused recovery code.");
  account.recoveryCodes.splice(index, 1);
  Object.assign(account, { recoveryCodesRemaining: account.recoveryCodes.length });
}
function establish(state: MockState, account: Account, time: number, mfa: boolean) {
  const data = identityState(state), id = allocate(state, "session"), at = new Date(time).toISOString();
  state.sessions[id] = { id, accountId: account.id, name: account.name, audience: "dashboard", expiresAt: new Date(time + 3_600_000).toISOString(), visibilityKey: "", revoked: false };
  data.sessionDetails[id] = { createdAt: at, lastActivityAt: at, authenticatedAt: at, mfa };
  state.activeSessionId = id;
  state.accessRevision++;
}
export function createIdentityServices(run: Run, wallTime: () => number): IdentityService {
  const generic = { message: "If this identity is eligible, a simulated message is available in the development mock inbox." };
  return {
    request: input => run((state, requestId) => {
      const data = identityState(state), email = emailAddress(input.email), time = now(state.clock, wallTime());
      if (!["signup", "signin", "github", "recovery"].includes(input.purpose)) throw new Refusal("validation", "Unknown sign-in method.");
      if (input.purpose === "signup" && (!input.termsAccepted || !input.name?.trim())) throw new Refusal("validation", "Name and acceptance of mock terms version mock-2026-09 are required.");
      let account = Object.values(data.accounts).find(a => (input.purpose === "github" ? a.githubEmail : a.email) === email && a.status !== "deleted");
      if (!account && input.purpose === "signup") {
        const id = allocate(state, "account");
        account = { id, name: requiredName(input.name!), email, avatar: "", revision: "r1", status: "pending", termsVersion: "mock-2026-09", methods: ["email"], mfa: false, recoveryCodes: [], recoveryCodesRemaining: 0, notifications: true };
        data.accounts[id] = account; state.accounts[id] = { id, name: account.name };
      }
      if (account && !["operator", "app", "worker"].includes(account.id)) {
        const purpose = input.purpose === "signup" ? (account.status === "pending" ? "signup" : "signin") : input.purpose;
        if ((purpose === "github" && account.methods.includes("github")) || (purpose !== "github" && account.methods.includes("email"))) {
          challenge(state, account.id, email, purpose === "recovery" ? "signin" : purpose, input.returnTo ?? "/organizations", time);
          accountAudit(state, account.id, "challenge.requested", requestId, time);
        }
      }
      return generic;
    }, { mutate: true }),
    complete: (token, code) => run((state, requestId) => {
      const data = identityState(state), time = now(state.clock, wallTime());
      const item = Object.values(data.challenges).find(c => c.token === token);
      if (!item || item.used || Date.parse(item.expiresAt) <= time) throw new Refusal("validation", "Invalid, expired or already used challenge. Request a new link.");
      const account = data.accounts[item.accountId];
      if (!account || account.status === "deleted") throw new Refusal("validation", "Identity is unavailable.");
      if ((["signup", "signin"].includes(item.purpose) && (!account.methods.includes("email") || account.email !== item.email)) ||
          (item.purpose === "github" && (!account.methods.includes("github") || account.githubEmail !== item.email)))
        throw new Refusal("validation", "This sign-in method changed. Request a new challenge for a linked identity.");
      if (["email", "link-github"].includes(item.purpose)) {
        if (accountFor(state, wallTime()).id !== account.id) throw new Refusal("forbidden", "Sign in to the account that requested this identity change.");
        fresh(state, wallTime());
      }
      if (account.mfa && item.purpose !== "recovery-code") verifyMfa(state, account.id, code);
      if (item.purpose === "email") {
        if (account.pendingEmail !== item.email || Object.values(data.accounts).some(a => a.id !== account.id && a.status !== "deleted" && a.email === item.email)) throw new Refusal("conflict", "Email is no longer available. Request a new verification.");
        Object.assign(account, { email: item.email, pendingEmail: undefined, methods: [...new Set([...account.methods, "email"])] });
      } else if (item.purpose === "link-github") {
        if (Object.values(data.accounts).some(a => a.id !== account.id && a.githubEmail === item.email && a.status !== "deleted")) throw new Refusal("conflict", "Provider identity is already linked.");
        Object.assign(account, { methods: [...new Set([...account.methods, "github"])], githubEmail: item.email });
      } else {
        Object.assign(account, { status: "active", verifiedAt: account.verifiedAt ?? new Date(time).toISOString() });
        establish(state, account, time, account.mfa);
      }
      item.used = true;
      Object.assign(account, { revision: bump(account.revision) });
      accountAudit(state, account.id, `identity.${item.purpose}.completed`, requestId, time);
      return { returnTo: safeReturn(item.returnTo) };
    }, { mutate: true }),
    recover: (rawEmail, code) => run((state, requestId) => {
      const data = identityState(state), email = emailAddress(rawEmail), time = now(state.clock, wallTime());
      const account = Object.values(data.accounts).find(a => a.email === email && a.status === "active");
      if (account && code && account.recoveryCodes.includes(code)) {
        verifyMfa(state, account.id, code);
        // Possession of a one-use recovery code is the recovery proof; no email dependency.
        for (const session of Object.values(state.sessions)) if (session.accountId === account.id) session.revoked = true;
        establish(state, account, time, true);
        accountAudit(state, account.id, "account.recovered", requestId, time);
        return { message: "Recovery code consumed. Other sessions revoked. Update your security settings." };
      }
      const id = allocate(state, "support");
      data.supportCases[id] = { id, email, status: "pending" };
      return { message: `Recovery remains pending with mock support case ${id}. No access was granted.` };
    }, { mutate: true }),
    getAccount: context => run(state => {
      const { recoveryCodes: _, enrollment: __, githubEmail: ___, ...dto } = accountFor(state, wallTime());
      return dto;
    }, { signal: context?.signal }),
    listSessions: (page, context) => run(state => {
      const account = accountFor(state, wallTime()), data = identityState(state), session = requireSession(state, wallTime());
      return paginate(Object.values(state.sessions).filter(s => s.accountId === account.id).map(s => ({ ...s, ...data.sessionDetails[s.id], current: s.id === session.id })), page, session.visibilityKey);
    }, { signal: context?.signal }),
    command: (input, options) => run((state, requestId) => {
      const account = accountFor(state, wallTime()), data = identityState(state), session = requireSession(state, wallTime()), time = now(state.clock, wallTime());
      return once(state, account.id, undefined, input, options, (): CommandReceipt => {
        revision(account.revision, options);
        const result: { message: string; recoveryCodes?: string[] } = { message: "Account change saved." };
        if (!["profile", "notifications", "revoke-session", "revoke-others"].includes(input.kind)) fresh(state, wallTime());
        switch (input.kind) {
          case "profile": {
            const name = requiredName(input.name);
            if (input.avatar.length > 8) throw new Refusal("validation", "Use up to eight characters or an emoji for the local avatar.");
            Object.assign(account, { name, avatar: input.avatar }); state.accounts[account.id].name = name;
            for (const s of Object.values(state.sessions)) if (s.accountId === account.id) Object.assign(s, { name });
            state.accessRevision++; break;
          }
          case "email": {
            const email = emailAddress(input.email);
            if (Object.values(data.accounts).some(a => a.id !== account.id && a.email === email && a.status !== "deleted")) throw new Refusal("conflict", "This identity cannot be linked.");
            Object.assign(account, { pendingEmail: email }); challenge(state, account.id, email, "email", "/account/profile", time);
            result.message = "Verify the new address in the mock inbox before it replaces your email."; break;
          }
          case "link-github": challenge(state, account.id, emailAddress(input.email), "link-github", "/account/security", time); result.message = "Complete the simulated GitHub proof in the mock inbox."; break;
          case "unlink":
            if (account.methods.length <= 1 || !account.methods.includes(input.method)) throw new Refusal("conflict", "The final usable sign-in method cannot be removed.");
            Object.assign(account, { methods: account.methods.filter(m => m !== input.method), ...(input.method === "github" ? { githubEmail: undefined } : {}) }); break;
          case "mfa-start": account.enrollment = mfaCode(account.id); result.message = "Enrollment pending. Verify the code from the mock authenticator in development tools."; break;
          case "mfa-confirm":
            if (!account.enrollment || input.code !== account.enrollment) throw new Refusal("validation", "Enrollment code did not match.");
            Object.assign(account, { mfa: true, enrollment: undefined }); data.sessionDetails[session.id].mfa = true;
            account.recoveryCodes = Array.from({ length: 8 }, () => `mock-recovery-${crypto.randomUUID()}`);
            result.recoveryCodes = [...account.recoveryCodes]; break;
          case "recovery-reset":
            if (!account.mfa) throw new Refusal("conflict", "Enroll MFA first.");
            verifyMfa(state, account.id, input.code);
            account.recoveryCodes = Array.from({ length: 8 }, () => `mock-recovery-${crypto.randomUUID()}`); result.recoveryCodes = [...account.recoveryCodes]; break;
          case "mfa-disable":
            if (Object.values(state.memberships).some(m => m.active && m.accountId === account.id && data.organizations[m.orgId]?.requireMfa)) throw new Refusal("forbidden", "An organization requires MFA. Leave it or have its policy changed first.");
            verifyMfa(state, account.id, input.code); Object.assign(account, { mfa: false }); account.recoveryCodes = []; state.accessRevision++; break;
          case "revoke-session": {
            const target = state.sessions[input.sessionId];
            if (!target || target.accountId !== account.id) throw new Refusal("not_found", "Session not found.");
            target.revoked = true; state.accessRevision++; break;
          }
          case "revoke-others":
            for (const target of Object.values(state.sessions)) if (target.accountId === account.id && target.id !== session.id) target.revoked = true;
            state.accessRevision++; break;
          case "notifications": Object.assign(account, { notifications: input.enabled }); break;
          case "delete":
            if (input.confirmation !== account.email) throw new Refusal("validation", "Type your verified email to confirm account deletion.");
            if (Object.values(state.memberships).some(m => m.active && m.accountId === account.id && m.role === "Owner" && Object.values(state.memberships).filter(other => other.active && other.orgId === m.orgId && other.role === "Owner").length === 1)) throw new Refusal("conflict", "Sole ownership blocks deletion. Transfer ownership first.");
            Object.assign(account, { status: "deleted", recoveryCodes: [], methods: [], pendingEmail: undefined });
            for (const m of Object.values(state.memberships)) if (m.accountId === account.id) { m.active = false; m.grants = []; }
            for (const s of Object.values(state.sessions)) if (s.accountId === account.id) s.revoked = true;
            state.activeSessionId = null; state.accessRevision++; result.message = "Account deleted; audit tombstone retained."; break;
        }
        Object.assign(account, { revision: bump(account.revision), recoveryCodesRemaining: account.recoveryCodes.length });
        accountAudit(state, account.id, `account.${input.kind}`, requestId, time);
        return result;
      });
    }, { mutate: true }),
    listNotifications: (page, context) => run(state => {
      const account = accountFor(state, wallTime());
      return paginate(Object.values(identityState(state).notifications).filter(n => n.accountId === account.id), page, requireSession(state, wallTime()).visibilityKey);
    }, { signal: context?.signal }),
    markRead: id => run(state => {
      const account = accountFor(state, wallTime()), data = identityState(state), notification = data.notifications[id];
      if (!notification || notification.accountId !== account.id) throw new Refusal("not_found", "Notification not found.");
      data.notifications[id] = { ...notification, read: true };
    }, { mutate: true }),
  };
}
