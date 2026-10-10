import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter, useNavigate } from "react-router-dom";
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { App } from "../../presentation/App";
import { ServicesContext } from "../../presentation/framework/services/context";
import { SessionProvider } from "../../presentation/framework/session/SessionProvider";
import {
  createMockServices,
  type MockRuntime,
} from "../../infrastructure/browser/mock/create-mock-services";
import { MemoryPersistence } from "../../infrastructure/browser/mock/store";
import { seedFoundation } from "../../infrastructure/browser/mock/scenarios/foundation";
import { unwrap } from "../../presentation/framework/services/contracts";
let view: ReactTestRenderer;
let runtime: MockRuntime;
let cache: QueryClient;
let navigate: ReturnType<typeof useNavigate>;
beforeAll(() => notifyManager.setNotifyFunction((callback) => act(callback)));
afterAll(() => notifyManager.setNotifyFunction((callback) => callback()));
function Navigator() {
  navigate = useNavigate();
  return null;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
function text() {
  return JSON.stringify(view.toJSON());
}
async function ready() {
  for (let attempt = 0; attempt < 30; attempt++) {
    await act(async () => {
      await settle();
    });
    if (!cache.isFetching() && !text().includes("Resolving ") && !text().includes("Loading authorized resource") && !text().includes("Loading Registry records") && !text().includes("Loading subscription") && !text().includes("Loading operator metadata") && !text().includes("Loading capabilities")) return;
  }
  throw new Error("Presentation did not settle");
}
async function mount(path: string, identity = "owner") {
  runtime = createMockServices({
    persistence: new MemoryPersistence(seedFoundation(1000)),
    wallTime: () => 1000,
    autoTick: false,
  });
  unwrap(await runtime.tools.setLatency(0));
  unwrap(await runtime.tools.selectIdentity(identity));
  cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, networkMode: "always" },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    view = create(
      <QueryClientProvider client={cache}>
        <ServicesContext.Provider value={runtime.services}>
          <SessionProvider>
            <MemoryRouter
              initialEntries={[path]}
              future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
            >
              <Navigator />
              <App />
            </MemoryRouter>
          </SessionProvider>
        </ServicesContext.Provider>
      </QueryClientProvider>,
    );
    await settle();
  });
  await ready();
}
afterEach(async () => {
  await act(async () => {
    view?.unmount();
  });
  runtime?.dispose();
  cache?.clear();
});

test("deep links restore scope; switching tenants removes prior content during latency", async () => {
  await mount(
    "/orgs/org_north/projects/project_north_notes/environments/env_north_notes_development/overview",
  );
  expect(text()).toContain("Acme North");
  expect(text()).toContain("Canonical service bindings");
  unwrap(await runtime.tools.setLatency(80));
  await act(async () => {
    navigate(
      "/orgs/org_south/projects/project_south_notes/environments/env_south_notes_development/overview",
    );
  });
  expect(text()).not.toContain("Acme North");
  expect(text()).toContain("Resolving authorized scope");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
  });
  await ready();
  expect(text()).toContain("Acme South");
  expect(
    cache
      .getQueryCache()
      .getAll()
      .some((query) => query.queryKey.includes("org_north")),
  ).toBe(false);
});
test("membership revocation removes current resources and prevents stale cache reuse", async () => {
  await mount(
    "/orgs/org_north/projects/project_north_notes/environments/env_north_notes_development/overview",
    "developer",
  );
  expect(text()).toContain("Canonical service bindings");
  await act(async () => {
    unwrap(await runtime.tools.revokeMembership({ orgId: "org_north" }));
    await settle();
  });
  await ready();
  expect(text()).not.toContain("Canonical service bindings");
  expect(text()).toContain("not found");
});
test("expiry returns to sign-in and clears sensitive query projections", async () => {
  await mount(
    "/orgs/org_north/projects/project_north_notes/environments/env_north_notes_production/overview",
  );
  expect(text()).toContain("Production environment selected");
  await act(async () => {
    unwrap(await runtime.tools.setClock(true, 3_600_000));
    await settle();
  });
  await ready();
  expect(text()).toContain("Sign in to Carbon");
  expect(text()).not.toContain("Canonical service bindings");
  expect(cache.getQueryCache().getAll().length).toBe(0);
});
test("billing can see organization context without project resources", async () => {
  await mount("/orgs/org_north/overview", "billing");
  expect(text()).toContain("Billing access");
  expect(text()).not.toContain("project_north_notes");
});
test("Slice 8 project plugins, Slice 9 billing and unknown routes render explicitly", async () => {
  await mount("/orgs/org_north/projects/project_north_notes/plugins");
  expect(text()).toContain("Add exact Registry dependency");
  expect(text()).toContain("Resolve 1.2.0");
  await act(async () => { navigate("/orgs/org_north/billing"); });
  await ready();
  expect(text()).toContain("Subscription");
  await act(async () => {
    navigate("/missing-route");
    await settle();
  });
  expect(text()).toContain("Not found");
});

test("Slice 9 operator routes require the operator audience and support direct details", async () => {
  await mount("/operations", "operator");
  expect(text()).toContain("Platform operations");
  expect(text()).toContain("job_provision_failed");
  await act(async () => { navigate("/operations/workers"); });
  await ready(); expect(text()).toContain("Register managed worker");
  await act(async () => { navigate("/operations/jobs/job_provision_failed"); });
  await ready(); expect(text()).toContain("Retry failed step");
  await act(async () => { navigate("/operations/organizations/org_north"); });
  await ready(); expect(text()).toContain("customer data access"); expect(text()).toContain('"false"');
});

test("Slice 6 routes render working forms and retain direct resource details", async () => {
  const scope = { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" };
  const base = `/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}`;
  await mount(`${base}/storage`);
  expect(text()).toContain("Create bucket");
  const cases = [["database/vectors", "Create vector collection"], ["database/graph", "Create graph"], ["database/migrations", "Register migration revision"], ["database/backups", "Create environment snapshot"], ["realtime/inspector", "Connect / resume inspector"]];
  for (const [path, label] of cases) { await act(async () => { navigate(`${base}/${path}`); }); await ready(); expect(text()).toContain(label); expect(text()).not.toContain("This workflow is scheduled for Slice 6"); }
  const id = unwrap(await runtime.services.extensions.command({ scope }, { kind: "vector.create", name: "direct collection", dimensions: 2, metric: "dot" }, "", { idempotencyKey: "presentation-vector" })).resourceId!;
  await act(async () => { navigate(`${base}/database/vectors/${id}`); }); await ready();
  expect(text()).toContain("Upsert or import vector points"); expect(text()).toContain("direct collection");
  await act(async () => { navigate(`${base}/database/vectors/foreign-missing`); }); await ready(); expect(text()).toContain("Resource not found in this environment.");
});

test("MFA enrollment keeps one-time recovery codes visible after account refresh", async () => {
  await mount("/account/security");
  function form(title: string) {
    return view.root.findAllByType("form").find(f => f.findAllByType("h3").some(h => h.children.join("") === title))!;
  }
  await act(async () => { await form("Start MFA enrollment").props.onSubmit({ preventDefault() {} }); });
  await ready();
  const code = unwrap(await runtime.tools.inbox()).authenticators.find(a => a.accountId === "owner")!.code;
  await act(async () => { form("Verify MFA enrollment").findByType("input").props.onChange({ target: { value: code } }); });
  await act(async () => { await form("Verify MFA enrollment").props.onSubmit({ preventDefault() {} }); });
  await ready();
  expect(text()).toContain("Save these one-use recovery codes now");
  expect(text()).toContain("mock-recovery-");
  expect(text()).toContain("Replace recovery codes");
});

test("Slice 7 provisions explicitly, autosaves drafts and renders direct deployment, invocation and schedule pages", async () => {
  const scope = { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" }, context = { scope };
  const base = `/orgs/${scope.orgId}/projects/${scope.projectId}/environments/${scope.environmentId}/functions`;
  await mount(base); expect(text()).toContain("Enable Functions in environment overview");
  await act(async () => {
    unwrap(await runtime.services.platform.command(context, { kind: "provision", services: ["functions"] }, { expectedRevision: "r1", idempotencyKey: "functions-enable" }));
    unwrap(await runtime.tools.setClock(true, 5000));
  }); await ready(); expect(text()).toContain("Create function draft");
  const config = { handler: "echo" as const, authorization: "anonymous" as const, timeoutMs: 5000, memoryMb: 128, concurrency: 2, secrets: [] };
  let id = "";
  await act(async () => {
    id = unwrap(await runtime.services.functions.command(context, { kind: "create", name: "Presentation function", source: "source fixture", repositoryPath: "", config }, "", { idempotencyKey: "functions-create" })).resourceId!;
    navigate(`${base}/${id}`);
  }); await ready(); expect(text()).toContain("Source draft"); expect(text()).toContain("Deploy saved draft");
  await act(async () => { view.root.findAllByType("textarea")[0].props.onChange({ target: { value: "autosaved source fixture" } }); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); }); await ready();
  expect(unwrap(await runtime.services.functions.get(context, id)).draft.source).toBe("autosaved source fixture");
  await act(async () => {
    const form = view.root.findAllByType("form").find(f => f.findAllByType("h3").some(h => h.children.join("") === "Deploy saved draft"))!;
    await form.props.onSubmit({ preventDefault() {} }); unwrap(await runtime.tools.setClock(true, 4000));
  }); await ready(); expect(unwrap(await runtime.services.functions.get(context, id)).activeDeploymentId).toBeDefined();
  let invocation = "";
  await act(async () => {
    invocation = unwrap(await runtime.services.functions.invoke(context, id, { payload: { text: "fixture-output" }, headers: {}, identity: { mode: "anonymous" } }, "", { expectedRevision: unwrap(await runtime.services.functions.get(context, id)).revision, idempotencyKey: "ui-invoke" })).resourceId!;
    unwrap(await runtime.tools.setClock(true, 4000)); navigate(`${base}/${id}/invocations/${invocation}`);
  }); await ready(); expect(text()).toContain("succeeded"); expect(text()).not.toContain("fixture-output");
  await act(async () => { view.root.findAllByType("input").find(i => i.props.type === "checkbox")!.props.onChange({ target: { checked: true } }); }); await ready(); expect(text()).toContain("fixture-output");
  await act(async () => { navigate(`${base}/${id}/schedules`); }); await ready(); expect(text()).toContain("Create schedule"); expect(text()).toContain("daylightSaving");
  await act(async () => { navigate(`${base}/${id}/invocations/missing`); }); await ready(); expect(text()).toContain("Invocation not found");
  await act(async () => { navigate(`${base}/missing`); }); await ready(); expect(text()).toContain("Resource not found in this environment");
});
