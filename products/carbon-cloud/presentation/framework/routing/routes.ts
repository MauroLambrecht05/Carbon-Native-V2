import { matchPath } from "react-router-dom";
import type { Scope } from "../services/contracts";
export const O = "/orgs/:orgId";
export const P = `${O}/projects/:projectId`;
export const E = `${P}/environments/:environmentId`;
export interface RouteDefinition {
  path: string;
  label: string;
  slice: number;
  audience: "public" | "dashboard" | "operator" | "app";
}
const definitions = (
  prefix: string,
  entries: readonly (readonly [string, string, number])[],
  audience: RouteDefinition["audience"] = "dashboard",
): RouteDefinition[] =>
  entries.map(([path, label, slice]) => ({
    path: prefix + path,
    label,
    slice,
    audience,
  }));
export const routes: readonly RouteDefinition[] = [
  ...definitions(
    "",
    [
      ["/", "Home", 1],
      ["/sign-up", "Create account", 2],
      ["/sign-in", "Sign in", 2],
      ["/auth/callback", "Account callback", 2],
      // The paths the live service puts in its emails.
      ["/auth/complete", "Account callback", 2],
      ["/invitations/accept", "Invitation", 2],
      ["/auth/recovery", "Account recovery", 2],
      ["/invites/:token", "Invitation", 2],
      ["/registry", "Registry", 8],
      ["/registry/:packageId", "Package", 8],
    ],
    "public",
  ),
  ...definitions("", [
    ["/organizations", "Organizations", 1],
    ["/authorize-cli", "Authorize CLI", 3],
    ["/account/profile", "Profile", 2],
    ["/account/security", "Security", 2],
    ["/account/sessions", "Sessions", 2],
    ["/account/tokens", "Personal tokens", 3],
    ["/account/notifications", "Notifications", 2],
  ]),
  ...definitions(O, [
    ["/overview", "Organization overview", 1],
    ["/projects", "Projects", 1],
    ["/members", "Members", 2],
    ["/settings", "Organization settings", 2],
    ["/security", "Organization security", 2],
    ["/credentials", "Credentials", 3],
    ["/connections", "Repository connections", 3],
    ["/billing", "Billing", 9],
    ["/usage", "Usage", 9],
    ["/activity", "Activity", 3],
    ["/publishing", "Publishing", 8],
    ["/publishing/:packageId", "Package settings", 8],
    ["/publishing/:packageId/versions/:versionId", "Package version", 8],
    ["/workers", "Organization workers", 4],
  ]),
  ...definitions(P, [
    ["/overview", "Project overview", 1],
    ["/settings/general", "General settings", 3],
    ["/settings/access", "Project access", 2],
    ["/settings/environments", "Environments", 2],
    ["/settings/repository", "Repository", 3],
    ["/settings/build", "Build configuration", 4],
    ["/settings/signing", "Signing", 4],
    ["/builds", "Builds", 4],
    ["/builds/:buildId", "Build", 4],
    ["/releases", "Releases", 4],
    ["/releases/:releaseId", "Release", 4],
    ["/channels", "Update channels", 4],
    ["/channels/:channelId", "Update channel", 4],
    ["/plugins", "Project plugins", 8],
    ["/plugins/:dependencyId", "Dependency", 8],
    ["/activity", "Project activity", 3],
  ]),
  ...definitions(E, [
    ["/overview", "Environment overview", 1],
    ["/database/tables", "Tables", 5],
    ["/database/tables/:tableId", "Table", 5],
    ["/database/sql", "SQL", 5],
    ["/database/migrations", "Migrations", 6],
    ["/database/backups", "Backups", 6],
    ["/database/vectors", "Vectors", 6],
    ["/database/vectors/:collectionId", "Vector collection", 6],
    ["/database/graph", "Graph", 6],
    ["/storage", "Storage", 6],
    ["/storage/:bucketId", "Bucket", 6],
    ["/auth/users", "App users", 5],
    ["/auth/users/:userId", "App user", 5],
    ["/auth/providers", "App auth providers", 5],
    ["/auth/settings", "App auth settings", 5],
    ["/auth/events", "App auth events", 5],
    ["/functions", "Functions", 7],
    ["/functions/:functionId", "Function", 7],
    ["/functions/:functionId/invocations/:invocationId", "Invocation", 7],
    ["/functions/:functionId/schedules", "Schedules", 7],
    ["/realtime", "Realtime", 6],
    ["/realtime/inspector", "Realtime inspector", 6],
    ["/settings/api", "API settings", 3],
    ["/settings/secrets", "Secrets", 3],
    ["/settings/limits", "Limits", 9],
    ["/foundation/operations/:operationId", "Mock operation", 1],
  ]),
  ...definitions(
    "",
    [
      ["/app-auth/:realmId/sign-in", "Application sign in", 5],
      ["/app-auth/:realmId/callback", "Application callback", 5],
    ],
    "app",
  ),
  ...definitions(
    "/operations",
    [
      ["", "Platform operations", 9],
      ["/organizations/:orgId", "Operator organization metadata", 9],
      ["/jobs/:jobId", "Operator job", 9],
      ["/workers", "Managed workers", 9],
      ["/registry", "Registry review", 9],
      ["/trust", "Platform trust", 9],
      ["/audit", "Operator audit", 9],
    ],
    "operator",
  ),
];
export function resolveRoute(pathname: string) {
  for (const route of routes) {
    const match = matchPath({ path: route.path, end: true }, pathname);
    if (match) {
      const { orgId, projectId, environmentId } = match.params;
      const scope: Scope | undefined =
        route.audience !== "operator" && orgId
          ? {
              orgId,
              ...(projectId ? { projectId } : {}),
              ...(environmentId ? { environmentId } : {}),
            }
          : undefined;
      return { route, scope, params: match.params };
    }
  }
  return null;
}
export function scopePath(scope: Scope): string {
  return `/orgs/${encodeURIComponent(scope.orgId)}${scope.projectId ? `/projects/${encodeURIComponent(scope.projectId)}` : ""}${scope.environmentId ? `/environments/${encodeURIComponent(scope.environmentId)}` : ""}`;
}
export function safeReturn(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value)
  )
    return "/organizations";
  try {
    const url = new URL(value, "https://mock.invalid");
    return url.origin === "https://mock.invalid" && resolveRoute(url.pathname)
      ? url.pathname + url.search
      : "/organizations";
  } catch {
    return "/organizations";
  }
}
