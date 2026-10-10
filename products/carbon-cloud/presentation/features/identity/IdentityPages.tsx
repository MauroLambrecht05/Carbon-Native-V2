import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { scopeKey } from "../../framework/queries/scope-cache";
import { safeReturn } from "../../framework/routing/routes";
import { useServices } from "../../framework/services/context";
import { unwrap } from "../../framework/services/contracts";
import { useSession } from "../../framework/session/SessionProvider";
import { CommandForm, choices } from "./Forms";

export function AuthPage() {
  const services = useServices(), location = useLocation(), navigate = useNavigate();
  const params = new URLSearchParams(location.search), returnTo = safeReturn(params.get("returnTo"));
  const signup = location.pathname === "/sign-up", recovery = location.pathname === "/auth/recovery", callback = location.pathname === "/auth/callback";
  return <section><h1>{callback ? "Complete sign-in or identity verification" : recovery ? "Recover your Carbon account" : signup ? "Create your Carbon account" : "Sign in to Carbon"}</h1>
    <p>Carbon account authentication. Email and GitHub flows are simulated locally. Open development mock tools below to follow the delivered challenge.</p>
    {callback ? <CommandForm title="Complete verification" sensitive fields={[{ name: "code", label: "MFA or recovery code (if enrolled)", secret: true, required: false }]} submit={async v => {
      const result = await services.identity.complete(params.get("token") ?? "", v.code);
      if (!result.ok) return result;
      navigate(safeReturn(result.value.returnTo), { replace: true }); return { ok: true, value: { message: "Verification complete." } };
    }} /> : <>
      <CommandForm title={signup ? "Request verification" : recovery ? "Send an alternative email sign-in link" : "Send sign-in link"} fields={[
        ...(signup ? [{ name: "name", label: "Name" }] : []), { name: "email", label: "Email", type: "email" },
        ...(signup ? [{ name: "terms", label: "Mock terms mock-2026-09", options: [{ value: "", label: "Choose…" }, { value: "accepted", label: "I accept the mock terms" }] }] : []),
      ]} submit={v => services.identity.request({ email: v.email, name: v.name, termsAccepted: v.terms === "accepted", purpose: signup ? "signup" : recovery ? "recovery" : "signin", returnTo })}>
        {signup && <p>Mock terms: this is a local demonstration using fake data. No account, email or payment is created with a live service.</p>}
      </CommandForm>
      {!signup && !recovery && <CommandForm title="Continue with configured GitHub (mock)" fields={[{ name: "email", label: "Linked GitHub email", type: "email" }]} submit={v => services.identity.request({ email: v.email, purpose: "github", returnTo })} />}
      {recovery && <CommandForm title="Recover with a code or open a support case" sensitive fields={[{ name: "email", label: "Account email", type: "email" }, { name: "code", label: "One-use recovery code; leave empty for pending support", secret: true, required: false }]} submit={v => services.identity.recover(v.email, v.code)} />}
    </>}
    <nav aria-label="Authentication"><Link to={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link><Link to={`/sign-up?returnTo=${encodeURIComponent(returnTo)}`}>Create account</Link><Link to="/auth/recovery">Account recovery</Link></nav>
  </section>;
}
export function AccountPage() {
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
  const services = useServices(), { session } = useSession(), location = useLocation();
  const query = useQuery({ queryKey: [...scopeKey(session!.visibilityKey), "account"], queryFn: async ({ signal }) => unwrap(await services.identity.getAccount({ signal })) });
  if (query.isPending) return <p role="status">Loading account…</p>;
  if (query.error) return <Feedback error={query.error} retry={() => void query.refetch()} />;
  const account = query.data, section = location.pathname.split("/").at(-1);
  return <section><h1>Account · {account.name}</h1><nav aria-label="Account">{["profile", "security", "sessions", "tokens", "notifications"].map(page => <Link key={page} to={`/account/${page}`}>{page}</Link>)}</nav>
    <p>{account.avatar} {account.email} · {account.status} · Revision {account.revision}</p>
    {recoveryCodes && <aside className="notice"><p>Save these one-use recovery codes now. They cannot be retrieved again.</p><pre>{recoveryCodes.join("\n")}</pre><button onClick={() => setRecoveryCodes(undefined)}>I saved my codes</button></aside>}
    {section === "profile" && <>
      <CommandForm title="Save profile" revision={account.revision} fields={[{ name: "name", label: "Name", value: account.name }, { name: "avatar", label: "Avatar initials or emoji (up to 8 characters)", value: account.avatar, required: false }]} submit={(v, o) => services.identity.command({ kind: "profile", name: v.name, avatar: v.avatar }, o)} />
      <CommandForm title="Verify new email" revision={account.revision} fields={[{ name: "email", label: "New email", type: "email" }]} submit={(v, o) => services.identity.command({ kind: "email", email: v.email }, o)} />
      {account.pendingEmail && <p>Awaiting verification: {account.pendingEmail}. Current email remains {account.email}.</p>}
      <CommandForm title="Delete account" revision={account.revision} fields={[{ name: "confirmation", label: `Type ${account.email}` }]} submit={(v, o) => services.identity.command({ kind: "delete", confirmation: v.confirmation }, o)}><p>This revokes sessions and memberships. Sole organization ownership blocks deletion. Audit tombstones remain.</p></CommandForm>
    </>}
    {section === "security" && <>
      <p>MFA: {account.mfa ? "enabled" : "disabled"}. Recovery codes remaining: {account.recoveryCodesRemaining}. Sensitive changes require authentication within five simulated minutes.</p>
      <Link to="/sign-in?returnTo=%2Faccount%2Fsecurity">Authenticate again</Link>
      <CommandForm title="Start MFA enrollment" revision={account.revision} disabled={account.mfa ? "MFA is already enabled; reset recovery codes below." : undefined} submit={(_, o) => services.identity.command({ kind: "mfa-start" }, o)} />
      {!account.mfa && <CommandForm title="Verify MFA enrollment" after={r => setRecoveryCodes(r.recoveryCodes)} revision={account.revision} sensitive fields={[{ name: "code", label: "Mock authenticator code", secret: true }]} submit={(v, o) => services.identity.command({ kind: "mfa-confirm", code: v.code }, o)} />}
      {account.mfa && <>{(["recovery-reset", "mfa-disable"] as const).map(kind => <CommandForm key={kind} after={r => setRecoveryCodes(r.recoveryCodes)} title={kind === "recovery-reset" ? "Replace recovery codes" : "Disable MFA"} sensitive revision={account.revision} fields={[{ name: "code", label: "Authenticator or unused recovery code", secret: true }]} submit={(v, o) => services.identity.command({ kind, code: v.code }, o)} />)}</>}
      <p>Sign-in methods: {account.methods.join(", ")}. Link proof is delivered to the mock inbox.</p>
      {!account.methods.includes("github") && <CommandForm title="Link GitHub identity" revision={account.revision} fields={[{ name: "email", label: "GitHub email", type: "email" }]} submit={(v, o) => services.identity.command({ kind: "link-github", email: v.email }, o)} />}
      {account.methods.map(method => <CommandForm key={method} title={`Unlink ${method}`} revision={account.revision} disabled={account.methods.length === 1 ? "The last usable sign-in method must remain linked." : undefined} submit={(_, o) => services.identity.command({ kind: "unlink", method }, o)} />)}
      <p><Link to="/auth/recovery">Recover access</Link></p>
    </>}
    {section === "sessions" && <SessionList revision={account.revision} />}
    {section === "notifications" && <><CommandForm title="Save notification preference" revision={account.revision} fields={[{ name: "enabled", label: "Optional notifications", value: String(account.notifications), options: choices(["true", "false"]) }]} submit={(v, o) => services.identity.command({ kind: "notifications", enabled: v.enabled === "true" }, o)} /><NotificationList /></>}
  </section>;
}
function SessionList({ revision }: { revision: string }) {
  const services = useServices(), { session } = useSession(), [params, setParams] = useSearchParams();
  const cursor = params.get("cursor") ?? undefined;
  const query = useQuery({ queryKey: [...scopeKey(session!.visibilityKey), "sessions", cursor], queryFn: async ({ signal }) => unwrap(await services.identity.listSessions({ limit: 5, cursor }, { signal })) });
  return <><CommandForm title="Revoke all other sessions" revision={revision} submit={(_, o) => services.identity.command({ kind: "revoke-others" }, o)} />
    {query.isPending ? <p>Loading sessions…</p> : query.error ? <Feedback error={query.error} retry={() => void query.refetch()} /> : <>{query.data.items.map(s => <article key={s.id}><h3>{s.current ? "Current session" : "Other session"} · {s.revoked ? "revoked" : "expires " + s.expiresAt}</h3><code>{s.id}</code><p>Created {s.createdAt} · Last activity {s.lastActivityAt}</p><CommandForm title={`Revoke ${s.current ? "current" : s.id} session`} revision={revision} disabled={s.revoked ? "Already revoked" : undefined} submit={(_, o) => services.identity.command({ kind: "revoke-session", sessionId: s.id }, o)} /></article>)}<Pager cursor={cursor} next={query.data.nextCursor} change={value => setParams(value ? { cursor: value } : {})} /></>}
  </>;
}
function NotificationList() {
  const services = useServices(), { session } = useSession(), cache = useQueryClient(), [params, setParams] = useSearchParams();
  const cursor = params.get("cursor") ?? undefined;
  const query = useQuery({ queryKey: [...scopeKey(session!.visibilityKey), "notifications", cursor], queryFn: async ({ signal }) => unwrap(await services.identity.listNotifications({ limit: 10, cursor }, { signal })) });
  return query.isPending ? <p>Loading notifications…</p> : query.error ? <Feedback error={query.error} retry={() => void query.refetch()} /> : <><h2>Inbox</h2>{!query.data.items.length && <p>No notifications. Organization invitations and ownership requests will appear here.</p>}{query.data.items.map(n => <article key={n.id}><Link to={n.href}>{n.name}</Link><p>{n.createdAt} · {n.read ? "read" : "unread"}</p>{!n.read && <CommandForm title="Mark read" submit={async () => { const result = await services.identity.markRead(n.id); if (!result.ok) return result; void cache.invalidateQueries(); return { ok: true, value: { message: "Marked read." } }; }} />}</article>)}<Pager cursor={cursor} next={query.data.nextCursor} change={value => setParams(value ? { cursor: value } : {})} /></>;
}
export function InvitationPage({ token }: { token: string }) {
  const services = useServices(), { session } = useSession(), navigate = useNavigate();
  const query = useQuery({ queryKey: [...scopeKey(session?.visibilityKey ?? "visitor"), "invite", token], queryFn: async () => unwrap(await services.platform.previewInvitation(token)) });
  if (query.isPending) return <p>Loading invitation…</p>;
  if (query.error) return <Feedback error={query.error} retry={() => void query.refetch()} />;
  const invite = query.data, destination = encodeURIComponent(`/invites/${token}`);
  return <section><h1>Invitation to {invite.organization}</h1><p>Role: {invite.role} · {invite.status} · Expires {invite.expiresAt}</p>{!session ? <nav><Link to={`/sign-in?returnTo=${destination}`}>Sign in to respond</Link><Link to={`/sign-up?returnTo=${destination}`}>Create account to respond</Link></nav> : <>{[true, false].map(accept => <CommandForm key={String(accept)} title={accept ? "Accept invitation" : "Decline invitation"} disabled={invite.status !== "pending" ? `Invitation is ${invite.status}.` : undefined} submit={async () => { const result = await services.platform.respondInvitation(token, accept); if (!result.ok) return result; navigate(accept ? `/orgs/${result.value.orgId}/overview` : "/organizations"); return { ok: true, value: { message: "Response saved." } }; }} />)}</>}</section>;
}
export function Pager({ cursor, next, change }: { cursor?: string; next: string | null; change: (value?: string) => void }) {
  return <div className="controls"><button disabled={!cursor} onClick={() => change()}>First page</button><button disabled={!next} onClick={() => change(next!)}>Next page</button></div>;
}

