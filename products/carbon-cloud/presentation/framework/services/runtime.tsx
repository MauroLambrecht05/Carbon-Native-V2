import { createContext, useContext } from "react";

/** Whether this page talks to the real service or to the local mock. Pages use it only to say true things about where data goes. */
export type Runtime = Readonly<{ live: boolean }>;
/** The slices of the route catalog that are connected to the live service. Every other route says so instead of rendering. */
export const LIVE_SLICES: ReadonlySet<number> = new Set([1, 2, 7]);
/**
 * Routes that are connected although the rest of their slice is not. The delivery slice also holds build
 * configuration and organization workers, which have no pages against the live service yet.
 */
const LIVE_ROUTES: readonly string[] = ["/builds", "/builds/:buildId", "/releases", "/releases/:releaseId", "/channels", "/channels/:channelId", "/settings/signing", "/activity"];
/** The same, for routes of an organization. */
const LIVE_ORGANIZATION_ROUTES: readonly string[] = ["/activity", "/workers"];
/** The same, for routes of an environment. */
const LIVE_ENVIRONMENT_ROUTES: readonly string[] = ["/settings/secrets", "/settings/api"];
/** Whether a route of the catalog has a page against the live service. */
export const isLive = (route: { slice: number; path: string }) => LIVE_SLICES.has(route.slice) || LIVE_ROUTES.some(suffix => route.path.endsWith(`/projects/:projectId${suffix}`))
  || LIVE_ORGANIZATION_ROUTES.some(suffix => route.path === `/orgs/:orgId${suffix}`) || LIVE_ENVIRONMENT_ROUTES.some(suffix => route.path.endsWith(`/environments/:environmentId${suffix}`));
export const RuntimeContext = createContext<Runtime>({ live: false });
export const useRuntime = () => useContext(RuntimeContext);
