import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  createMockServices,
  type MockRuntime,
} from "../../infrastructure/browser/mock/create-mock-services";
import {
  MemoryPersistence,
  openIndexedDb,
  type Persistence,
} from "../../infrastructure/browser/mock/store";
import { seedFoundation } from "../../infrastructure/browser/mock/scenarios/foundation";
import {
  unwrap,
  type Result,
  type Scope,
  type SubscriptionMessage,
} from "../../presentation/framework/services/contracts";
import {
  resolveRoute,
  routes,
  safeReturn,
  scopePath,
} from "../../presentation/framework/routing/routes";
const north: Scope = {
  orgId: "org_north",
  projectId: "project_north_notes",
  environmentId: "env_north_notes_development",
};
const south: Scope = {
  orgId: "org_south",
  projectId: "project_south_notes",
  environmentId: "env_south_notes_development",
};
const runtimes: MockRuntime[] = [];
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
async function setup(identity = "owner", persistence?: Persistence) {
  let wall = 1000;
  const store = persistence ?? new MemoryPersistence(seedFoundation(wall));
  const runtime = createMockServices({
    persistence: store,
    wallTime: () => wall,
    autoTick: false,
  });
  runtimes.push(runtime);
  unwrap(await runtime.tools.setLatency(0));
  unwrap(await runtime.tools.selectIdentity(identity));
  return {
    ...runtime,
    store,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}
function code(result: Result<unknown>) {
  expect(result.ok).toBe(false);
  return result.ok ? null : result.error.code;
}

describe("Slice 1 browser contracts", () => {
  test("visitor, empty account, membership and audience separation", async () => {
    const app = await setup("new");
    expect(unwrap(await app.services.catalog.listOrganizations()).total).toBe(
      0,
    );
    for (const audience of ["app", "worker", "operator"]) {
      unwrap(await app.tools.selectIdentity(audience));
      expect(
        code(await app.services.catalog.resolveScope({ scope: north })),
      ).toBe("forbidden");
    }
    unwrap(await app.services.session.signOut());
    expect(unwrap(await app.services.session.getSession())).toBeNull();
    expect(code(await app.services.catalog.listOrganizations())).toBe(
      "unauthenticated",
    );
  });
  test("stable scope ownership hides foreign and mismatched IDs", async () => {
    const app = await setup("developer");
    expect(
      unwrap(await app.services.catalog.resolveScope({ scope: north })).project
        ?.name,
    ).toBe("Notes");
    expect(
      code(await app.services.catalog.resolveScope({ scope: south })),
    ).toBe("not_found");
    expect(
      code(
        await app.services.catalog.resolveScope({
          scope: { ...north, environmentId: south.environmentId },
        }),
      ),
    ).toBe("not_found");
    expect(
      code(
        await app.services.catalog.resolveScope({
          scope: { orgId: north.orgId, environmentId: north.environmentId },
        }),
      ),
    ).toBe("validation");
    const org = unwrap(
      await app.services.catalog.resolveScope({
        scope: { orgId: north.orgId },
      }),
    );
    expect(
      org.bindings.every(
        (binding) => binding.scope.projectId === north.projectId,
      ),
    ).toBe(true);
    expect(
      unwrap(
        await app.services.catalog.listProjects({
          scope: { orgId: north.orgId },
        }),
      ).items.map((project) => project.id),
    ).toEqual([north.projectId!]);
  });
  test("production and customer-data grants are distinct from developer metadata access", async () => {
    const app = await setup("developer");
    const dev = unwrap(
      await app.services.catalog.resolveScope({ scope: north }),
    );
    expect(dev.permissions["metadata.read"].allowed).toBe(true);
    expect(dev.permissions["data.read"].allowed).toBe(false);
    const production = {
      ...north,
      environmentId: "env_north_notes_production",
    };
    expect(
      code(
        await app.tools.startCheck(production, "success", {
          idempotencyKey: "denied",
        }),
      ),
    ).toBe("forbidden");
    unwrap(await app.tools.selectIdentity("billing"));
    const billing = unwrap(
      await app.services.catalog.resolveScope({
        scope: { orgId: north.orgId },
      }),
    );
    expect(billing.bindings).toEqual([]);
    expect(billing.permissions["billing.manage"].allowed).toBe(true);
    expect(
      code(
        await app.services.catalog.listProjects({
          scope: { orgId: north.orgId },
        }),
      ),
    ).toBe("forbidden");
  });
  test("pagination is deterministic, filter-aware and bound to visibility", async () => {
    const app = await setup();
    const first = unwrap(
      await app.services.catalog.listOrganizations({ limit: 1, sort: "name" }),
    );
    const second = unwrap(
      await app.services.catalog.listOrganizations({
        limit: 1,
        sort: "name",
        cursor: first.nextCursor!,
      }),
    );
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(second.nextCursor).toBeNull();
    expect(
      code(
        await app.services.catalog.listOrganizations({
          limit: 1,
          sort: "id",
          cursor: first.nextCursor!,
        }),
      ),
    ).toBe("validation");
    expect(
      code(await app.services.catalog.listOrganizations({ limit: 101 })),
    ).toBe("validation");
    expect(
      unwrap(
        await app.services.catalog.listOrganizations({
          filter: { name: "missing" },
        }),
      ).total,
    ).toBe(0);
    unwrap(await app.tools.selectIdentity("developer"));
    expect(
      code(
        await app.services.catalog.listOrganizations({
          limit: 1,
          sort: "name",
          cursor: first.nextCursor!,
        }),
      ),
    ).toBe("validation");
  });
  test("DTO mutation cannot change persisted state", async () => {
    const app = await setup();
    const dto = unwrap(
      await app.services.catalog.resolveScope({ scope: north }),
    );
    (dto.project as { name: string }).name = "tampered";
    expect(
      unwrap(await app.services.catalog.resolveScope({ scope: north })).project
        ?.name,
    ).toBe("Notes");
  });
  test("idempotency recovers committed-but-lost responses and rejects payload reuse", async () => {
    const app = await setup();
    unwrap(
      await app.tools.injectFailure("foundation.start", "unavailable", "after"),
    );
    expect(
      code(
        await app.tools.startCheck(north, "success", {
          idempotencyKey: "lost",
        }),
      ),
    ).toBe("unavailable");
    const original = unwrap(
      await app.tools.startCheck(north, "success", { idempotencyKey: "lost" }),
    );
    expect(
      unwrap(
        await app.tools.startCheck(north, "success", {
          idempotencyKey: "lost",
        }),
      ).id,
    ).toBe(original.id);
    expect(
      unwrap(await app.services.operations.list({ scope: north })).total,
    ).toBe(1);
    expect(
      code(
        await app.tools.startCheck(north, "partial_failure", {
          idempotencyKey: "lost",
        }),
      ),
    ).toBe("conflict");
  });
  test("queued cancellation stays terminal and stale edits conflict", async () => {
    const app = await setup();
    const operation = unwrap(
      await app.tools.startCheck(north, "success", {
        idempotencyKey: "cancel",
      }),
    );
    const cancelled = unwrap(
      await app.services.operations.requestCancel(
        { scope: north },
        operation.id,
        {
          idempotencyKey: "cancel-command",
          expectedRevision: operation.revision,
        },
      ),
    );
    expect(cancelled.state).toBe("cancelled");
    app.advance(60_000);
    await app.tick();
    expect(
      unwrap(await app.services.operations.get({ scope: north }, operation.id))
        .state,
    ).toBe("cancelled");
    expect(
      code(
        await app.services.operations.requestCancel(
          { scope: north },
          operation.id,
          { idempotencyKey: "stale", expectedRevision: operation.revision },
        ),
      ),
    ).toBe("conflict");
  });
  test("running cancellation is acknowledged and cannot later become success", async () => {
    const app = await setup();
    const operation = unwrap(
      await app.tools.startCheck(north, "success", {
        idempotencyKey: "running",
      }),
    );
    app.advance(1000);
    const running = unwrap(
      await app.services.operations.get({ scope: north }, operation.id),
    );
    expect(running.state).toBe("running");
    expect(
      unwrap(
        await app.services.operations.requestCancel(
          { scope: north },
          operation.id,
          { idempotencyKey: "stop", expectedRevision: running.revision },
        ),
      ).state,
    ).toBe("cancel_requested");
    app.advance(10_000);
    await app.tick();
    expect(
      unwrap(await app.services.operations.get({ scope: north }, operation.id))
        .state,
    ).toBe("cancelled");
  });
  test("partial failure retains completed steps and retry resumes the same operation", async () => {
    const app = await setup();
    const operation = unwrap(
      await app.tools.startCheck(north, "partial_failure", {
        idempotencyKey: "partial",
      }),
    );
    app.advance(5000);
    const failed = unwrap(
      await app.services.operations.get({ scope: north }, operation.id),
    );
    expect(failed.state).toBe("failed");
    expect(failed.completedSteps).toBe(1);
    const retried = unwrap(
      await app.services.operations.retryAllowedStep(
        { scope: north },
        operation.id,
        { idempotencyKey: "retry", expectedRevision: failed.revision },
      ),
    );
    expect(retried.id).toBe(operation.id);
    expect(retried.completedSteps).toBe(1);
    app.advance(5000);
    expect(
      unwrap(await app.services.operations.get({ scope: north }, operation.id))
        .state,
    ).toBe("succeeded");
    const audit = unwrap(
      await app.services.activity.listAudit({ scope: north }),
    );
    expect(audit.items.some((entry) => entry.outcome === "failed")).toBe(true);
  });
  test("operation lists cannot disclose unassigned child projects", async () => {
    const app = await setup();
    const other = {
      ...north,
      projectId: "project_north_desk",
      environmentId: "env_north_desk_development",
    };
    const privateOperation = unwrap(
      await app.tools.startCheck(other, "success", {
        idempotencyKey: "private",
      }),
    );
    unwrap(await app.tools.selectIdentity("developer"));
    expect(
      unwrap(
        await app.services.operations.list({ scope: { orgId: north.orgId } }),
      ).items,
    ).toEqual([]);
    expect(
      code(
        await app.services.operations.get(
          { scope: { orgId: north.orgId } },
          privateOperation.id,
        ),
      ),
    ).toBe("not_found");
  });
  test("aborted and obsolete-principal reads cannot return old data", async () => {
    const app = await setup();
    unwrap(await app.tools.setLatency(40));
    const controller = new AbortController();
    const request = app.services.catalog.resolveScope({
      scope: north,
      signal: controller.signal,
    });
    controller.abort();
    expect(code(await request)).toBe("cancelled");
    const stale = app.services.catalog.resolveScope({ scope: south });
    await pause();
    unwrap(await app.tools.selectIdentity("developer"));
    expect(code(await stale)).toBe("unauthenticated");
  });
  test("subscriptions replay ordered cursors, deduplicate, and close on membership revocation", async () => {
    const app = await setup("developer");
    const messages: SubscriptionMessage[] = [];
    unwrap(
      await app.services.events.subscribe({ scope: north }, "0", (message) =>
        messages.push(message),
      ),
    );
    unwrap(
      await app.tools.startCheck(north, "success", {
        idempotencyKey: "events",
      }),
    );
    app.advance(5000);
    await app.tick();
    await pause();
    const cursors = messages.flatMap((message) =>
      message.events.map((event) => event.cursor),
    );
    expect(cursors.length).toBe(5);
    expect(new Set(cursors).size).toBe(cursors.length);
    unwrap(await app.tools.revokeMembership(north));
    await pause();
    expect(messages.at(-1)?.state).toBe("closed");
    expect(
      code(await app.services.catalog.resolveScope({ scope: north })),
    ).toBe("not_found");
  });
  test("clock pause, explicit advance and expiry revoke existing session access", async () => {
    const app = await setup();
    unwrap(await app.tools.setClock(true));
    const before = unwrap(await app.tools.inspect()).now;
    app.advance(100_000);
    expect(unwrap(await app.tools.inspect()).now).toBe(before);
    unwrap(await app.tools.setClock(true, 3_600_000));
    expect(unwrap(await app.services.session.getSession())).toBeNull();
    expect(code(await app.services.operations.list({ scope: north }))).toBe(
      "unauthenticated",
    );
  });
  test("failure is one-shot and successful or denied calls are honest", async () => {
    const app = await setup();
    unwrap(await app.tools.injectFailure("catalog.resolve", "rate_limited"));
    const failure = await app.services.catalog.resolveScope({ scope: north });
    expect(code(failure)).toBe("rate_limited");
    if (!failure.ok) expect(failure.error.retryAfterMs).toBe(1000);
    expect((await app.services.catalog.resolveScope({ scope: north })).ok).toBe(
      true,
    );
    expect(
      unwrap(
        await app.services.capabilities.getAvailableCapabilities({
          scope: north,
        }),
      )
        .filter((entry) => entry.available)
        .map((entry) => entry.id),
    ).toEqual(["foundation", "billing", "operators", "registry", "identity", "data-extensions", "functions", "database", "app-auth", "configuration", "builds", "releases", "client.pause-withdrawal"]);
  });
  test("reset needs confirmation and last owner cannot be removed", async () => {
    const app = await setup();
    expect(code(await app.tools.revokeMembership(north))).toBe("conflict");
    expect(code(await app.tools.reset(""))).toBe("validation");
    unwrap(await app.tools.reset("RESET MOCK"));
    expect(unwrap(await app.services.session.getSession())).toBeNull();
  });
  test("route catalog restores only canonical scopes and keeps operator/app audiences separate", () => {
    for (const route of routes) {
      const path = route.path.replace(/:([a-zA-Z]+)/g, "$1_fixture");
      expect(resolveRoute(path)?.route.path).toBe(route.path);
    }
    expect(resolveRoute(`${scopePath(north)}/overview`)?.scope).toEqual(north);
    expect(
      resolveRoute("/operations/organizations/org_north")?.scope,
    ).toBeUndefined();
    expect(
      resolveRoute("/app-auth/realm_fixture/sign-in")?.route.audience,
    ).toBe("app");
    expect(resolveRoute("/unknown")).toBeNull();
    for (const unsafe of [
      "https://evil.invalid",
      "//evil.invalid",
      "/\\evil.invalid",
      "/%2f%2fevil.invalid",
    ])
      expect(safeReturn(unsafe)).toBe("/organizations");
  });
});

describe("IndexedDB persistence boundary", () => {
  test("two coordinators commit one idempotent job and reload reconciles once", async () => {
    const factory = new IDBFactory();
    const seed = seedFoundation(1000);
    const first = await openIndexedDb(seed, factory, "shared");
    const second = await openIndexedDb(seed, factory, "shared");
    const app = await setup("owner", first);
    const peer = createMockServices({
      persistence: second,
      wallTime: () => 1000,
      autoTick: false,
    });
    runtimes.push(peer);
    const [a, b] = await Promise.all([
      app.tools.startCheck(north, "success", { idempotencyKey: "race" }),
      peer.tools.startCheck(north, "success", { idempotencyKey: "race" }),
    ]);
    expect(unwrap(a).id).toBe(unwrap(b).id);
    const reloadedStore = await openIndexedDb(seed, factory, "shared");
    const reloaded = createMockServices({
      persistence: reloadedStore,
      wallTime: () => 10_000,
      autoTick: false,
    });
    runtimes.push(reloaded);
    await Promise.all([reloaded.tick(), reloaded.tick()]);
    expect(
      unwrap(
        await reloaded.services.operations.get({ scope: north }, unwrap(a).id),
      ).state,
    ).toBe("succeeded");
    const snapshot = await first.transact((state) => ({
      value: {
        operations: Object.keys(state.operations).length,
        events: Object.values(state.events).filter(
          (event) => event.action === "operation.succeeded",
        ).length,
      },
      changed: false,
    }));
    expect(snapshot).toEqual({ operations: 1, events: 1 });
  });
  test("transaction failures roll back and incompatible data is never overwritten", async () => {
    const factory = new IDBFactory();
    const seed = seedFoundation(1000);
    const store = await openIndexedDb(seed, factory, "rollback");
    await expect(
      store.transact((state) => {
        state.organizations = {};
        throw new Error("commit refused");
      }),
    ).rejects.toThrow("commit refused");
    expect(
      await store.transact((state) => ({
        value: Object.keys(state.organizations).length,
        changed: false,
      })),
    ).toBe(2);
    await store.reset({ ...seed, schemaVersion: 999 });
    await expect(
      store.transact(() => ({ value: undefined, changed: false })),
    ).rejects.toThrow("Incompatible mock schema");
    await store.reset(seed);
    expect(
      await store.transact((state) => ({
        value: state.schemaVersion,
        changed: false,
      })),
    ).toBe(1);
    store.close();
  });
  test("storage failure produces unavailable, with no success or fallback", async () => {
    const broken: Persistence = {
      transact: async () => {
        throw new Error("QuotaExceededError");
      },
      reset: async () => {
        throw new Error("QuotaExceededError");
      },
      close() {},
    };
    const runtime = createMockServices({
      persistence: broken,
      autoTick: false,
    });
    runtimes.push(runtime);
    expect(
      code(
        await runtime.tools.startCheck(north, "success", {
          idempotencyKey: "quota",
        }),
      ),
    ).toBe("unavailable");
  });
});
