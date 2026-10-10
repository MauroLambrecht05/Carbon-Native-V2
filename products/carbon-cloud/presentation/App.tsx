import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, Navigate, useLocation } from "react-router-dom";
import { Feedback } from "./components/Feedback";
import { CatalogPage } from "./features/foundation/CatalogPage";
import { ScopePage } from "./features/foundation/ScopePage";
import { ScopeCache } from "./framework/queries/scope-cache";
import { resolveRoute } from "./framework/routing/routes";
import { useSession } from "./framework/session/SessionProvider";
import { useServices } from "./framework/services/context";
import { unwrap } from "./framework/services/contracts";
import { AccountPage, AuthPage, InvitationPage } from "./features/identity/IdentityPages";
import { CreateResource, Invitations } from "./features/identity/PlatformPages";
import { AccountConfigurationPage } from "./features/configuration/ConfigurationPages";
import { HostedAppAuth } from "./features/data/AppAuthPages";
import { PublicRegistryPage } from "./features/registry/RegistryPages";
import { OperatorPages } from "./features/operations/OperatorPages";
export function App({ tools }: { tools?: ReactNode }) {
  const location = useLocation();
  const match = resolveRoute(location.pathname);
  const { session, loading, error } = useSession();
  const services = useServices();
  const signOut = useMutation({
    mutationFn: async () => unwrap(await services.session.signOut()),
  });
  let content: ReactNode;
  if (loading) content = <p role="status">Resolving session…</p>;
  else if (error) content = <Feedback error={error.message} />;
  else if (!match)
    content = (
      <>
        <h1>Not found</h1>
        <p>This route is not in the platform route catalog.</p>
        <Link to="/organizations">Open organizations</Link>
      </>
    );
  else if (location.pathname === "/")
    content = <Navigate replace to={session ? "/organizations" : "/sign-in"} />;
  else if (match.route.audience === "dashboard" && !session)
    content = (
      <Navigate
        replace
        to={`/sign-in?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
      />
    );
  else if (
    (match.route.audience === "dashboard" &&
      session?.audience !== "dashboard") ||
    (match.route.audience === "operator" && session?.audience !== "operator")
  )
    content = (
      <>
        <h1>Forbidden</h1>
        <p>
          This route requires a separate {match.route.audience} audience.
          Organization membership does not grant operator access.
        </p>
      </>
    );
  else if (["/sign-in", "/sign-up", "/auth/callback", "/auth/recovery"].includes(location.pathname)) content = <AuthPage key={location.pathname + location.search} />;
  else if (match.params.realmId) content = <HostedAppAuth key={match.params.realmId} realmId={match.params.realmId} />;
  else if (match.params.token) content = <InvitationPage token={match.params.token} />;
  else if (location.pathname === "/registry" || location.pathname.startsWith("/registry/")) content = <PublicRegistryPage />;
  else if (location.pathname === "/operations" || location.pathname.startsWith("/operations/")) content = <OperatorPages />;
  else if (location.pathname.startsWith("/account/") && match.route.slice === 2) content = <AccountPage key={location.pathname} />;
  else if ((location.pathname === "/authorize-cli" || location.pathname === "/account/tokens") && match.route.slice === 3) content = <AccountConfigurationPage key={location.pathname} />;
  else if (match.scope)
    content = (
      <ScopePage
        scope={match.scope}
        label={match.route.label}
        slice={match.route.slice}
        operationId={match.params.operationId}
      />
    );
  else if (location.pathname === "/organizations") content = <><CatalogPage /><CreateResource /><Invitations /></>;
  else
    content = (
      <>
        <h1>{match.route.label}</h1>
        <p>
          {`Capability unavailable. This workflow arrives in Slice ${match.route.slice}.`}
        </p>
      </>
    );
  return (
    <>
      <header>
        <Link to="/">Carbon Cloud</Link>
        <span>Slices 9–10 · Billing, operators and consistency · local mock</span>
        <nav aria-label="Global navigation">
          <Link to="/organizations">Organizations</Link>
          <Link to="/registry">Registry</Link>
          <Link to="/account/profile">Account</Link>
          <Link to="/operations">Operations</Link>
        </nav>
        {session && (
          <p>
            {session.name} · {session.audience} ·{" "}
            <button
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              {signOut.isPending ? "Signing out…" : "Sign out"}
            </button>
          </p>
        )}
      </header>
      <main>
        {signOut.error && <Feedback error={signOut.error} />}
        <ScopeCache
          key={`${session?.visibilityKey ?? "visitor"}:${JSON.stringify(match?.scope)}`}
          scope={match?.scope}
        >
          {content}
        </ScopeCache>
        {tools}
      </main>
    </>
  );
}
