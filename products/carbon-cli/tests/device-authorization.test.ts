import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDataRequest, canonicalRegistryRequest, dataRequestPath, registryRequestPath, type DataRequest, type DeviceGrant, type RegistryRequest } from "@carbon/contracts/platform";
import { DeviceAuthorizationClient, type HttpTransport } from "../infrastructure/cloud/DeviceAuthorizationClient.ts";
import { DatabaseDeviceClient } from "../infrastructure/cloud/DatabaseDeviceClient.ts";
import { RegistryDeviceClient } from "../infrastructure/cloud/RegistryDeviceClient.ts";
import { cloudCommand } from "../presentation/commands/cloud/cloud.command.ts";
import { DeviceCredentialStore, type SecretStore } from "../infrastructure/cloud/DeviceCredentialStore.ts";

const orgId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const environmentId = "33333333-3333-4333-8333-333333333333";
const bindingId = "44444444-4444-4444-8444-444444444444";
const grantId = "55555555-5555-4555-8555-555555555555";
const deviceToken = `dc_${"d".repeat(43)}`;
const assertionToken = `assertion.${"a".repeat(80)}`;
const now = new Date();
const grant: DeviceGrant = {
  id: grantId, clientName: "Carbon CLI", deviceName: "Workstation",
  scope: { orgId, projectId, environmentId }, permissions: ["metadata.read", "data.read"],
  status: "active", expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  lastUsedAt: null, revision: "1", createdAt: now.toISOString(),
};

function json(value: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "x-request-id": requestId } });
}

describe("CLI device authorization", () => {
  test("honors slowdown and pending states before returning the one-time device credential", async () => {
    let polls = 0;
    const transport: HttpTransport = async (input, init) => {
      const requestId = new Headers(init?.headers).get("x-request-id")!;
      if (String(input).endsWith("/device/authorizations")) return json({
        deviceCode: `dv_${"c".repeat(43)}`, userCode: "ABCD-EFGH", verificationUri: "https://cloud.example.com/authorize-cli",
        expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 5,
      }, requestId, 201);
      polls += 1;
      if (polls === 1) return json({}, requestId, 429);
      return polls === 2 ? json({ state: "pending", intervalSeconds: 5 }, requestId)
        : json({ state: "authorized", token: deviceToken, grant }, requestId);
    };
    let shown = "";
    const result = await new DeviceAuthorizationClient(transport).authorize("https://cloud.example.com", {
      clientName: "Carbon CLI", deviceName: "Workstation", scope: grant.scope, permissions: grant.permissions,
    }, { challenge: value => { shown = value.userCode; }, wait: async () => {} });
    expect(shown).toBe("ABCD-EFGH");
    expect(polls).toBe(3);
    expect(result.token).toBe(deviceToken);
  });

  test.each(["denied", "expired", "consumed"] as const)("fails closed when authorization is %s", async state => {
    const transport: HttpTransport = async (input, init) => {
      const requestId = new Headers(init?.headers).get("x-request-id")!;
      return String(input).endsWith("/device/authorizations")
        ? json({ deviceCode: `dv_${"c".repeat(43)}`, userCode: "ABCD-EFGH", verificationUri: "https://cloud.example.com/authorize-cli", expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalSeconds: 5 }, requestId, 201)
        : json({ state }, requestId);
    };
    await expect(new DeviceAuthorizationClient(transport).authorize("https://cloud.example.com", {
      clientName: "Carbon CLI", deviceName: "Workstation", scope: grant.scope, permissions: grant.permissions,
    }, { challenge: () => {}, wait: async () => {} })).rejects.toThrow();
  });
});

describe("secure device credential storage", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  test("keeps the token out of profile metadata and removes it on logout", async () => {
    const values = new Map<string, string>();
    const secrets: SecretStore = {
      get: async ({ name }) => values.get(name) ?? null,
      set: async ({ name, value }) => { values.set(name, value); },
      delete: async ({ name }) => values.delete(name),
    };
    const directory = mkdtempSync(join(tmpdir(), "carbon-cli-device-")); directories.push(directory);
    const store = new DeviceCredentialStore(directory, secrets);
    await store.save("https://cloud.example.com", deviceToken, grant);
    expect((await store.active())?.token).toBe(deviceToken);
    expect(readFileSync(join(directory, "device-profile.json"), "utf8")).not.toContain(deviceToken);
    expect(await store.clear()).toBe(true);
    expect(await store.active()).toBeNull();
    expect(values.size).toBe(0);
  });
});

describe("Database assertion exchange", () => {
  test("binds a 60-second assertion to the exact canonical Database request", async () => {
    const request: DataRequest = { scope: { orgId, projectId, environmentId }, bindingId, command: { kind: "tables.list", limit: 25 } };
    let exchangeBody: any; let databaseBody = ""; let correlation = "";
    const transport: HttpTransport = async (input, init) => {
      const headers = new Headers(init?.headers); const requestId = headers.get("x-request-id")!;
      if (String(input).includes("device/assertions")) {
        exchangeBody = JSON.parse(String(init?.body)); correlation = requestId;
        expect(headers.get("authorization")).toBe(`Bearer ${deviceToken}`);
        return json({ tokenType: "Bearer", token: assertionToken, expiresInSeconds: 60 }, requestId);
      }
      databaseBody = String(init?.body);
      expect(requestId).toBe(correlation);
      expect(headers.get("authorization")).toBe(`Bearer ${assertionToken}`);
      expect(String(input)).toBe(`https://database.example.com${dataRequestPath(request.scope, bindingId, "tables.list")}`);
      return json({ scope: request.scope, bindingId, result: { tables: [], nextAfterId: null } }, requestId);
    };
    const result = await new DatabaseDeviceClient(transport).execute("https://database.example.com", { id: grantId, controlPlaneUrl: "https://cloud.example.com", grant }, deviceToken, request);
    expect(databaseBody).toBe(canonicalDataRequest(request));
    expect(exchangeBody.permission).toBe("metadata.read");
    expect(exchangeBody.request.path).toBe(dataRequestPath(request.scope, bindingId, "tables.list"));
    expect(exchangeBody.request.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.result).toEqual({ tables: [], nextAfterId: null });
  });

  test("does not contact Database when Cloud reports a revoked credential", async () => {
    let calls = 0;
    const transport: HttpTransport = async (_input, init) => { calls += 1; return json({}, new Headers(init?.headers).get("x-request-id")!, 401); };
    const request: DataRequest = { scope: { orgId, projectId, environmentId }, bindingId, command: { kind: "tables.list", limit: 25 } };
    await expect(new DatabaseDeviceClient(transport).execute("https://database.example.com", { id: grantId, controlPlaneUrl: "https://cloud.example.com", grant }, deviceToken, request)).rejects.toThrow("invalid or revoked");
    expect(calls).toBe(1);
  });
});

describe("Registry assertion exchange", () => {
  const registryBinding = "66666666-6666-4666-8666-666666666666";
  const request: RegistryRequest = { scope: { orgId, projectId, environmentId }, bindingId: registryBinding, command: { kind: "namespace.get" } };
  const profile = { id: grantId, controlPlaneUrl: "https://cloud.example.com", grant };
  const namespace = { id: "77777777-7777-4777-8777-777777777777", state: "active" as const, revision: "3" };

  test("uses the Registry-only exchange and binds the assertion to the exact canonical request", async () => {
    let exchangeBody: any; let registryBody = ""; let correlation = "";
    const transport: HttpTransport = async (input, init) => {
      const headers = new Headers(init?.headers); const requestId = headers.get("x-request-id")!;
      if (String(input).startsWith("https://cloud.example.com/")) {
        expect(String(input)).toBe("https://cloud.example.com/platform/v1/device/registry-assertions");
        exchangeBody = JSON.parse(String(init?.body)); correlation = requestId;
        expect(headers.get("authorization")).toBe(`Bearer ${deviceToken}`);
        return json({ tokenType: "Bearer", token: assertionToken, expiresInSeconds: 60 }, requestId);
      }
      registryBody = String(init?.body);
      expect(requestId).toBe(correlation);
      // Registry sees the short-lived assertion, never the device credential.
      expect(headers.get("authorization")).toBe(`Bearer ${assertionToken}`);
      expect(String(input)).toBe(`https://registry.example.com${registryRequestPath(request.scope, registryBinding, "namespace.get")}`);
      return json({ scope: request.scope, bindingId: registryBinding, result: namespace }, requestId);
    };
    const result = await new RegistryDeviceClient(transport).execute("https://registry.example.com", profile, deviceToken, request);
    expect(registryBody).toBe(canonicalRegistryRequest(request));
    expect(exchangeBody).toMatchObject({ audience: "carbon-registry", permission: "metadata.read", request: { method: "POST", path: registryRequestPath(request.scope, registryBinding, "namespace.get") } });
    expect(exchangeBody.request.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.result).toEqual(namespace);
  });

  test("stops before any network call when the request is outside the device grant", async () => {
    let calls = 0; const transport: HttpTransport = async (_input, init) => { calls += 1; return json({}, new Headers(init?.headers).get("x-request-id")!, 401); };
    const client = new RegistryDeviceClient(transport);
    await expect(client.execute("https://registry.example.com", profile, deviceToken, { ...request, scope: { ...request.scope, environmentId: bindingId } })).rejects.toThrow("does not match the active device scope");
    await expect(client.execute("https://registry.example.com", { ...profile, grant: { ...grant, permissions: ["data.read"] } }, deviceToken, request)).rejects.toThrow("does not include this registry permission");
    await expect(client.execute("http://registry.example.com", profile, deviceToken, request)).rejects.toThrow("HTTPS or loopback origin");
    expect(calls).toBe(0);
    await expect(client.execute("https://registry.example.com", profile, deviceToken, request)).rejects.toThrow("invalid or revoked");
    expect(calls).toBe(1);
  });

  test("rejects a Registry answer for a different binding or correlation", async () => {
    const answer = (body: unknown, mutate?: (id: string) => string): HttpTransport => async (input, init) => {
      const requestId = new Headers(init?.headers).get("x-request-id")!;
      if (String(input).startsWith("https://cloud.example.com/")) return json({ tokenType: "Bearer", token: assertionToken, expiresInSeconds: 60 }, requestId);
      return json(body, mutate ? mutate(requestId) : requestId);
    };
    await expect(new RegistryDeviceClient(answer({ scope: request.scope, bindingId, result: namespace })).execute("https://registry.example.com", profile, deviceToken, request)).rejects.toThrow("mismatched scope");
    await expect(new RegistryDeviceClient(answer({ scope: request.scope, bindingId: registryBinding, result: namespace }, () => grantId)).execute("https://registry.example.com", profile, deviceToken, request)).rejects.toThrow("invalid response");
  });

  test("carbon cloud namespace prints the namespace for the active device login", async () => {
    const calls: unknown[][] = [];
    const dependencies = {
      deviceClient: new DeviceAuthorizationClient(async () => { throw new Error("unused"); }),
      deviceStore: { active: async () => ({ profile, token: deviceToken }) } as unknown as DeviceCredentialStore,
      registryClient: { execute: async (...args: unknown[]) => { calls.push(args); return { scope: request.scope, bindingId: registryBinding, result: namespace }; } } as unknown as RegistryDeviceClient,
    };
    expect(await cloudCommand(["namespace", "--registry-url", "https://registry.example.com", "--binding", registryBinding], dependencies)).toBe(0);
    expect(calls).toEqual([["https://registry.example.com", profile, deviceToken, request]]);
    expect(await cloudCommand(["namespace", "--binding", registryBinding], dependencies)).toBe(1);
    expect(await cloudCommand(["namespace", "--registry-url", "https://registry.example.com"], dependencies)).toBe(1);
    expect(await cloudCommand(["namespace", "--registry-url", "https://registry.example.com", "--binding", registryBinding], { ...dependencies, deviceStore: { active: async () => null } as unknown as DeviceCredentialStore })).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
