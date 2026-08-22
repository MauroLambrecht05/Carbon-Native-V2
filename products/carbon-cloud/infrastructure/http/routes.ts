// The HTTP surface. Thin on purpose: every handler here does request
// parsing, calls exactly one solutions/capabilities/cloud-orchestration use
// case, and maps the result (or the error it threw) to a Response. No
// business logic lives in this file — that's the rule products/README.md
// states and this product follows deliberately.

import type { InstallerTargetId, TargetPlatform } from "@carbon/contracts/distribution";
import {
  BuildNotFoundError,
  InvalidTransitionError,
  type ClaimNextBuildUseCase,
  type CompleteBuildUseCase,
  type CreateBuildUseCase,
  type GetBuildUseCase,
  type ListOrgBuildsUseCase,
} from "@carbon/cloud-orchestration";
import {
  type CreateOrganizationUseCase,
  type IssueWorkerTokenUseCase,
  type VerifyTokenUseCase,
  type VerifiedToken,
  type TokenScope,
} from "@carbon/identity";
import {
  type CheckUsageLimitUseCase,
  type RecordBuildUsageUseCase,
  type StartPlanUpgradeUseCase,
  type ConfirmPlanUpgradeUseCase,
  type PlanId,
  verifyStripeWebhookSignature,
} from "@carbon/billing";

export interface RouteDeps {
  readonly createBuild: CreateBuildUseCase;
  readonly getBuild: GetBuildUseCase;
  readonly listOrgBuilds: ListOrgBuildsUseCase;
  readonly claimNext: ClaimNextBuildUseCase;
  readonly completeBuild: CompleteBuildUseCase;
  readonly createOrganization: CreateOrganizationUseCase;
  readonly issueWorkerToken: IssueWorkerTokenUseCase;
  readonly verifyToken: VerifyTokenUseCase;
  readonly checkUsageLimit: CheckUsageLimitUseCase;
  readonly recordBuildUsage: RecordBuildUsageUseCase;
  readonly startPlanUpgrade: StartPlanUpgradeUseCase;
  readonly confirmPlanUpgrade: ConfirmPlanUpgradeUseCase;
  /**
   * Undefined when running against FakeCheckoutSessionProvider (no real
   * Stripe account configured) — the webhook route 501s rather than
   * accepting unverifiable requests, since there's no secret to check a
   * signature against.
   */
  readonly stripeWebhookSecret?: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function errorResponse(error: unknown): Response {
  if (error instanceof BuildNotFoundError) return json({ error: error.message }, 404);
  if (error instanceof InvalidTransitionError) return json({ error: error.message }, 409);
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, 400);
}

/**
 * Who a request authenticates as, restricted to one of `allowedScopes`, or
 * a 401/403 Response to send back.
 *
 * This is what closes the gap the previous version of this file had: a
 * single token type could both queue work as an org AND pull any org's
 * queued work off the shared queue. Now claim/complete require a "worker"
 * token and create/usage require an "org" token — see ApiToken.ts's
 * TokenScope. `/v1/builds/claim`'s handler also threads `verified.orgId`
 * into ClaimNextBuildUseCase, so a worker token can only ever claim the
 * queue of the org that minted it — a self-hosted single-org deployment
 * sees no difference (it only ever had one org's builds to claim), but a
 * compromised worker token can no longer read what a different org is
 * building.
 */
async function authenticate(
  req: Request,
  verifyToken: VerifyTokenUseCase,
  allowedScopes: readonly TokenScope[],
): Promise<VerifiedToken | Response> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return json({ error: "missing bearer token" }, 401);

  const verified = await verifyToken.execute(token);
  if (!verified) return json({ error: "invalid token" }, 401);
  if (!allowedScopes.includes(verified.scope)) {
    return json({ error: `a ${verified.scope} token cannot do this — needs: ${allowedScopes.join(" or ")}` }, 403);
  }
  return verified;
}

const DASHBOARD_DIR = new URL("../../presentation/", import.meta.url);
const DASHBOARD_HTML = await Bun.file(new URL("index.html", DASHBOARD_DIR)).text();

// Bundled once at startup, not per request — the dashboard is React, and a
// build worker doesn't need Vite pulled in for one entry point when Bun's
// own bundler already resolves JSX and node_modules the same way.
const dashboardBuild = await Bun.build({
  entrypoints: [Bun.fileURLToPath(new URL("src/main.tsx", DASHBOARD_DIR))],
  target: "browser",
  minify: true,
});
if (!dashboardBuild.success) {
  throw new AggregateError(dashboardBuild.logs, "failed to build the dashboard bundle");
}
const DASHBOARD_JS = await dashboardBuild.outputs[0]!.text();

/** Bun.serve's `routes` object. The composition root is what calls Bun.serve. */
export function buildRoutes(deps: RouteDeps) {
  return {
    "/healthz": {
      GET: () => new Response("ok"),
    },

    "/": {
      GET: () => new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } }),
    },

    "/dashboard.js": {
      GET: () => new Response(DASHBOARD_JS, { headers: { "content-type": "text/javascript" } }),
    },

    "/v1/orgs": {
      POST: async (req: Bun.BunRequest) => {
        try {
          const body = (await req.json()) as { name: string };
          if (!body.name) return json({ error: "name is required" }, 400);
          const result = await deps.createOrganization.execute(body.name);
          return json(result, 201);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/worker-tokens": {
      POST: async (req: Bun.BunRequest) => {
        const verified = await authenticate(req, deps.verifyToken, ["org"]);
        if (verified instanceof Response) return verified;
        try {
          return json(await deps.issueWorkerToken.execute(verified.orgId), 201);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/usage": {
      GET: async (req: Bun.BunRequest) => {
        const verified = await authenticate(req, deps.verifyToken, ["org"]);
        if (verified instanceof Response) return verified;
        try {
          return json(await deps.checkUsageLimit.execute(verified.orgId));
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds": {
      GET: async (req: Bun.BunRequest) => {
        const verified = await authenticate(req, deps.verifyToken, ["org"]);
        if (verified instanceof Response) return verified;
        try {
          const limitParam = new URL(req.url).searchParams.get("limit");
          const builds = await deps.listOrgBuilds.execute(verified.orgId, limitParam ? Number(limitParam) : undefined);
          return json(builds.map((b) => b.toProps()));
        } catch (error) {
          return errorResponse(error);
        }
      },
      POST: async (req: Bun.BunRequest) => {
        const verified = await authenticate(req, deps.verifyToken, ["org"]);
        if (verified instanceof Response) return verified;
        try {
          const usage = await deps.checkUsageLimit.execute(verified.orgId);
          if (!usage.withinLimit) {
            return json(
              { error: `plan's ${usage.includedMinutes} included build-minutes used for this period` },
              402,
            );
          }
          const body = (await req.json()) as {
            repoUrl: string;
            commitSha: string;
            targets: InstallerTargetId[];
          };
          const build = await deps.createBuild.execute({ orgId: verified.orgId, ...body });
          return json(build.toProps(), 201);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds/:id": {
      GET: async (req: Bun.BunRequest<"/v1/builds/:id">) => {
        // Either scope: an org checks its own build, a worker checks one
        // it might be about to claim or just finished.
        const verified = await authenticate(req, deps.verifyToken, ["org", "worker"]);
        if (verified instanceof Response) return verified;
        try {
          const build = await deps.getBuild.execute(req.params.id);
          return json(build.toProps());
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds/claim": {
      POST: async (req: Bun.BunRequest) => {
        const verified = await authenticate(req, deps.verifyToken, ["worker"]);
        if (verified instanceof Response) return verified;
        try {
          const body = (await req.json()) as { platform: TargetPlatform; workerId: string };
          const build = await deps.claimNext.execute({ ...body, orgId: verified.orgId });
          return build ? json(build.toProps()) : json(null, 204);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/builds/:id/complete": {
      POST: async (req: Bun.BunRequest<"/v1/builds/:id/complete">) => {
        const verified = await authenticate(req, deps.verifyToken, ["worker"]);
        if (verified instanceof Response) return verified;
        try {
          const body = (await req.json()) as Record<string, unknown>;
          const buildId = req.params.id;
          await deps.completeBuild.execute({ ...body, buildId } as Parameters<
            CompleteBuildUseCase["execute"]
          >[0]);

          // Metered on wall time from creation to this outcome, not just
          // time spent "running" — queue wait is real cost too, and Build
          // doesn't track a separate started-running timestamp to bill off
          // instead. Only succeeded/failed are terminal; "running" isn't
          // billable yet.
          if (body.outcome === "succeeded" || body.outcome === "failed") {
            const build = (await deps.getBuild.execute(buildId)).toProps();
            await deps.recordBuildUsage.execute({
              orgId: build.orgId,
              buildId,
              durationMs: build.updatedAt.getTime() - build.createdAt.getTime(),
            });
          }

          return json({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    "/v1/billing/checkout": {
      POST: async (req: Bun.BunRequest) => {
        const verified = await authenticate(req, deps.verifyToken, ["org"]);
        if (verified instanceof Response) return verified;
        try {
          const body = (await req.json()) as { plan: PlanId };
          // Same-origin redirect targets: the dashboard IS what's serving
          // this request, at "/" — no separate PUBLIC_URL to configure.
          const origin = new URL(req.url).origin;
          const session = await deps.startPlanUpgrade.execute(
            verified.orgId,
            body.plan,
            `${origin}/?checkout=success`,
            `${origin}/?checkout=cancel`,
          );
          return json(session);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },

    // Stripe calls this directly — no bearer token, `Stripe-Signature`
    // instead. Reads the raw body text (not req.json()) because the
    // signature is computed over the exact bytes Stripe sent; re-serializing
    // a parsed-then-JSON.stringify'd copy would not reproduce them
    // byte-for-byte and every signature check would fail.
    "/v1/billing/webhook": {
      POST: async (req: Bun.BunRequest) => {
        if (!deps.stripeWebhookSecret) {
          return json({ error: "no Stripe webhook secret configured" }, 501);
        }
        const rawBody = await req.text();
        const signature = req.headers.get("stripe-signature");
        if (!verifyStripeWebhookSignature(rawBody, signature, deps.stripeWebhookSecret)) {
          return json({ error: "invalid signature" }, 400);
        }

        const event = JSON.parse(rawBody) as {
          type: string;
          data: { object: { metadata?: { orgId?: string; plan?: string } } };
        };
        if (event.type === "checkout.session.completed") {
          const { orgId, plan } = event.data.object.metadata ?? {};
          // Absent/malformed metadata on our own session is a config bug,
          // not a payment to silently drop — but there's nothing sane to
          // retry into, so this still 200s (Stripe retries a non-2xx
          // response, and retrying resolves nothing here).
          if (orgId && plan) await deps.confirmPlanUpgrade.execute(orgId, plan as PlanId);
        }
        return json({ received: true });
      },
    },
  };
}
