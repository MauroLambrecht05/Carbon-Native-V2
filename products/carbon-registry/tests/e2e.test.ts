// Exercises the real HTTP contract the CLI and presentation/src/api.ts
// depend on, over a real Bun.serve server — but with fakes standing in
// for identity (a real token comes from carbon-cloud, not this product)
// and RegistryEngine (real Postgres/S3 now — see that file's own header
// comment). Verified against a real request/response round trip, not
// direct function calls, the same posture carbon-cloud's own
// tests/routes.test.ts harness uses.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { VerifiedToken } from "@carbon/identity";
import { buildRegistryRoutes } from "../infrastructure/http/routes.ts";
import { startRegistryServer } from "../infrastructure/http/server.ts";
import { CarbonRegistryClient } from "../presentation/src/api.ts";
import type { PluginDetail, PublishRequest, RegistryEnginePort } from "../infrastructure/services/RegistryEngine.ts";
import { TrustSigner } from "../infrastructure/services/TrustSigner.ts";

const VALID_TOKEN = "cc_e2e_token";
const ORG_ID = "org-e2e-guild";

function fakeRegistrySystem() {
  // A real signer, not a fake — Postgres/S3 are faked below (a Map, no
  // database needed for this test), but the crypto is genuine, so this
  // test proves an actual Ed25519 round trip, not just that the right
  // fields get plumbed through.
  const signer = TrustSigner.fromHexSeed("ab".repeat(32));

  const plugins = new Map<string, PluginDetail>();
  const seedContent = Buffer.from("seed-clipboard-tarball-bytes");
  const seedSigned = signer.sign(seedContent);
  const seeded: PluginDetail = {
    name: "clipboard",
    category: "carbon-desktop",
    description: "Native clipboard",
    authorOrgId: "org-carbon-core",
    authorName: "Carbon Team",
    latestVersion: "1.0.0",
    downloads: 120,
    verified: true,
    tags: ["clipboard", "desktop"],
    platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
    createdAt: new Date().toISOString(),
    readme: "# Clipboard Plugin",
    versions: {
      "1.0.0": {
        version: "1.0.0",
        checksumSha256: seedSigned.checksumSha256,
        signatureBase64: seedSigned.signatureBase64,
        platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
        abiVersion: "v1.0",
        permissions: [],
        publishedAt: new Date().toISOString(),
      },
    },
  };
  plugins.set(seeded.name, seeded);

  // Real bytes per plugin@version, so download() returns exactly what got
  // signed — a fabricated placeholder string here would make the
  // signature verification below fail even though nothing is actually
  // wrong, which would be a fake test passing for the wrong reason.
  const content = new Map<string, Buffer>([[`${seeded.name}@${seeded.latestVersion}`, seedContent]]);

  const engine: RegistryEnginePort = {
    async getStats() {
      return {
        totalPackages: plugins.size,
        totalDownloads: Array.from(plugins.values()).reduce((sum, p) => sum + p.downloads, 0),
        totalAuthors: new Set(Array.from(plugins.values()).map((p) => p.authorOrgId)).size,
        categories: Array.from(new Set(Array.from(plugins.values()).map((p) => p.category))),
      };
    },
    async listPlugins(filter = {}) {
      let list = Array.from(plugins.values());
      if (filter.search) {
        const q = filter.search.toLowerCase();
        list = list.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
      }
      return {
        plugins: list.map((p) => ({ ...p, versions: undefined } as any)),
        total: list.length,
      };
    },
    async getPlugin(name) {
      return plugins.get(name);
    },
    async download(name, version) {
      const plugin = plugins.get(name);
      if (!plugin) throw new Error(`Plugin "${name}" not found`);
      const targetVersion = version || plugin.latestVersion;
      const record = plugin.versions[targetVersion];
      const bytes = content.get(`${name}@${targetVersion}`);
      if (!record || !bytes) throw new Error(`Version "${targetVersion}" not found`);
      return {
        tarballBase64: bytes.toString("base64"),
        checksum: record.checksumSha256,
        signatureBase64: record.signatureBase64,
        version: targetVersion,
      };
    },
    async publish(req: PublishRequest) {
      const { name, version } = req.manifest;
      const tarballBytes = Buffer.from(req.tarballBase64, "base64");
      const signed = signer.sign(tarballBytes);
      content.set(`${name}@${version}`, tarballBytes);
      const existing = plugins.get(name);
      const versionRecord = {
        version,
        checksumSha256: signed.checksumSha256,
        signatureBase64: signed.signatureBase64,
        platforms: req.manifest.platforms || ["windows-x86_64", "macos-arm64", "linux-x86_64"],
        abiVersion: req.manifest.abiVersion || "v1.0",
        permissions: req.manifest.permissions || [],
        publishedAt: new Date().toISOString(),
      };
      plugins.set(name, {
        name,
        category: req.manifest.category,
        description: req.manifest.description,
        authorOrgId: req.authorOrgId,
        authorName: req.authorName,
        latestVersion: version,
        downloads: existing?.downloads ?? 0,
        verified: req.authorOrgId === "org-carbon-core",
        tags: req.tags || [req.manifest.category, name],
        platforms: versionRecord.platforms,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        readme: req.readme || `# ${name}`,
        versions: { ...(existing?.versions || {}), [version]: versionRecord },
      });
      return { name, version, checksum: signed.checksumSha256, signatureBase64: signed.signatureBase64 };
    },
    getPublicKeyHex() {
      return signer.publicKeyHex;
    },
  };

  const verifyToken = {
    execute: async (token: string): Promise<VerifiedToken | null> =>
      token === VALID_TOKEN ? { orgId: ORG_ID, scope: "org" as const } : null,
  };

  return buildRegistryRoutes({ verifyToken, registryEngine: engine });
}

describe("Carbon Registry E2E Test Suite", () => {
  let server: any;
  let client: CarbonRegistryClient;

  beforeAll(() => {
    const handler = fakeRegistrySystem();
    server = startRegistryServer({ port: 0, handler });
    client = new CarbonRegistryClient(`http://localhost:${server.port}`, VALID_TOKEN);
  });

  afterAll(() => {
    if (server?.stop) server.stop();
  });

  test("full author & consumer lifecycle: health, stats, publish, search, detail, download", async () => {
    const health = await client.getHealth();
    expect(health.status).toBe("healthy");
    expect(health.service).toBe("carbon-registry");

    const stats = await client.getStats();
    expect(stats.totalPackages).toBeGreaterThanOrEqual(1);

    const dummyTarball = Buffer.from("midi-controller-zig-bytecode").toString("base64");
    const pub = await client.publishPlugin({
      manifest: {
        name: "midi-synth",
        version: "1.0.0",
        category: "carbon-media",
        description: "Hardware MIDI synthesizer and sequencer plugin for Carbon apps",
        platforms: ["windows-x86_64", "macos-arm64", "linux-x86_64"],
      },
      readme: "# MIDI Synth\n\nDirect low-latency MIDI in/out port controller.",
      tarballBase64: dummyTarball,
      authorName: "Audio Labs",
      tags: ["midi", "music", "audio", "synth"],
    });

    expect(pub.success).toBe(true);
    expect(pub.name).toBe("midi-synth");

    const search = await client.listPlugins({ search: "synth" });
    expect(search.plugins.length).toBeGreaterThanOrEqual(1);
    expect(search.plugins.some((p) => p.name === "midi-synth")).toBe(true);

    const detail = await client.getPlugin("midi-synth");
    expect(detail.name).toBe("midi-synth");
    expect(detail.category).toBe("carbon-media");
    expect(detail.readme).toContain("MIDI Synth");
    expect(detail.versions["1.0.0"]).toBeDefined();

    const dl = await client.downloadPlugin("midi-synth");
    expect(dl.version).toBe("1.0.0");
    expect(dl.signatureBase64).toBe(pub.signatureBase64);

    // The actual trust property this whole feature exists for: a
    // downloader with nothing but the registry's advertised public key
    // and the bytes it just received can independently confirm Carbon
    // signed exactly this tarball — the same check carbon-cli's
    // AddPluginCommand runs before writing anything to disk.
    const { publicKeyHex, algorithm } = await client.getTrustPublicKey();
    expect(algorithm).toBe("ed25519");
    const digest = createHash("sha256").update(Buffer.from(dl.tarballBase64, "base64")).digest();
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyHex, "hex").toString("base64url") } as any,
      format: "jwk",
    });
    const verified = edVerify(null, digest, publicKey, Buffer.from(dl.signatureBase64, "base64"));
    expect(verified).toBe(true);

    // And a tampered payload — same signature, different bytes — must fail.
    const tamperedDigest = createHash("sha256").update(Buffer.from("not the real tarball")).digest();
    const rejectsTampering = edVerify(null, tamperedDigest, publicKey, Buffer.from(dl.signatureBase64, "base64"));
    expect(rejectsTampering).toBe(false);
  });

  test("publish without a valid token is rejected", async () => {
    const unauthed = new CarbonRegistryClient(`http://localhost:${server.port}`);
    await expect(
      unauthed.publishPlugin({
        manifest: { name: "should-fail", version: "1.0.0", category: "carbon-dev", description: "no token" },
        tarballBase64: Buffer.from("x").toString("base64"),
      }),
    ).rejects.toThrow();
  });
});
