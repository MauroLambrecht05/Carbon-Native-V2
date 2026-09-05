// Real end-to-end coverage for the security property carbon-registry's
// TrustSigner and this CLI's verifyRegistrySignature exist to provide:
// `carbon plugin add @registry/x` must refuse to write anything to disk
// when the downloaded tarball's signature doesn't verify — a corrupted
// download, a tampered response, or a registry signing with a key that
// doesn't match what it advertises. Spins up a REAL local HTTP server and
// REAL Ed25519 keys (via node:crypto, the same scheme TrustSigner.ts
// documents), not a mocked fetch — the crypto itself is what's under test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginCommand } from "../presentation/commands/plugins/plugin.command.ts";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function makeSigner(seedByte: number) {
  const seed = Buffer.alloc(32, seedByte);
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  const publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex");
  return {
    publicKeyHex,
    sign(content: Buffer): string {
      const digest = createHash("sha256").update(content).digest();
      return edSign(null, digest, privateKey).toString("base64");
    },
  };
}

function fakeCtx(cwd: string) {
  const output: string[] = [];
  return {
    ctx: {
      first: "@registry/hotkey-plugin",
      args: ["@registry/hotkey-plugin"],
      cwd,
      io: {
        raw: (m: string) => output.push(m),
        info: (m: string) => output.push(m),
        error: (m: string) => output.push(m),
        success: (m: string) => output.push(m),
        isInteractive: () => false,
        c: { bold: (s: string) => s, dim: (s: string) => s, green: (s: string) => s, cyan: (s: string) => s, yellow: (s: string) => s },
      },
    } as any,
    output,
  };
}

describe("carbon plugin add @registry/x — signature verification", () => {
  let projectDir: string;
  let server: any;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "carbon-plugin-sig-test-"));
  });

  afterEach(() => {
    if (server?.stop) server.stop();
    rmSync(projectDir, { recursive: true, force: true });
    delete process.env.CARBON_REGISTRY_URL;
  });

  test("installs when the signature verifies against the registry's own advertised key", async () => {
    const signer = makeSigner(0x11);
    const tarball = Buffer.from("real-hotkey-plugin-bytes");
    const signatureBase64 = signer.sign(tarball);

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/plugins/hotkey-plugin/download") {
          return Response.json({ tarballBase64: tarball.toString("base64"), checksum: "x", signatureBase64, version: "1.0.0" });
        }
        if (url.pathname === "/api/v1/trust/public-key") {
          return Response.json({ publicKeyHex: signer.publicKeyHex, algorithm: "ed25519" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.CARBON_REGISTRY_URL = `http://localhost:${server.port}`;

    const addSub = new PluginCommand().subcommands.find((s) => s.meta.name === "add")!;
    const { ctx } = fakeCtx(projectDir);
    const code = await addSub.execute(ctx);

    expect(code).toBe(0);
    const dest = join(projectDir, "carbon", "plugins", "vendor", "hotkey-plugin");
    expect(existsSync(join(dest, "package.tar.zst"))).toBe(true);
    expect(readFileSync(join(dest, "package.tar.zst"))).toEqual(tarball);
  });

  test("refuses to install when the signature was made by a DIFFERENT key than the registry advertises", async () => {
    const realSigner = makeSigner(0x22);
    const attackerSigner = makeSigner(0x33);
    const tarball = Buffer.from("tampered-or-substituted-bytes");
    // Signed by the wrong key — simulates either a corrupted transport or
    // a registry impersonation, not a code path this CLI should special-case.
    const wrongSignatureBase64 = attackerSigner.sign(tarball);

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/plugins/hotkey-plugin/download") {
          return Response.json({ tarballBase64: tarball.toString("base64"), checksum: "x", signatureBase64: wrongSignatureBase64, version: "1.0.0" });
        }
        if (url.pathname === "/api/v1/trust/public-key") {
          return Response.json({ publicKeyHex: realSigner.publicKeyHex, algorithm: "ed25519" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    process.env.CARBON_REGISTRY_URL = `http://localhost:${server.port}`;

    const addSub = new PluginCommand().subcommands.find((s) => s.meta.name === "add")!;
    const { ctx, output } = fakeCtx(projectDir);
    const code = await addSub.execute(ctx);

    expect(code).not.toBe(0);
    expect(output.join("\n")).toContain("signature verification failed");
    // The refusal must be real — nothing gets written, not even partially.
    expect(existsSync(join(projectDir, "carbon", "plugins", "vendor", "hotkey-plugin"))).toBe(false);
  });

  test("refuses to install when the registry's public-key endpoint is unreachable", async () => {
    const signer = makeSigner(0x44);
    const tarball = Buffer.from("some plugin bytes");
    const signatureBase64 = signer.sign(tarball);

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/plugins/hotkey-plugin/download") {
          return Response.json({ tarballBase64: tarball.toString("base64"), checksum: "x", signatureBase64, version: "1.0.0" });
        }
        // No /api/v1/trust/public-key route at all — simulates an older
        // or misconfigured registry that never advertises a key.
        return new Response("not found", { status: 404 });
      },
    });
    process.env.CARBON_REGISTRY_URL = `http://localhost:${server.port}`;

    const addSub = new PluginCommand().subcommands.find((s) => s.meta.name === "add")!;
    const { ctx } = fakeCtx(projectDir);
    const code = await addSub.execute(ctx);

    expect(code).not.toBe(0);
    expect(existsSync(join(projectDir, "carbon", "plugins", "vendor", "hotkey-plugin"))).toBe(false);
  });
});
