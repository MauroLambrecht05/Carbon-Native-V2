import { describe, expect, test } from "bun:test";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "@carbon/process";
import { signAuthenticode, AuthenticodeSignError } from "../index.ts";

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  constructor(private readonly result: ProcessResult = { code: 0, signal: null }) {}
  async run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    return this.result;
  }
}

describe("signAuthenticode", () => {
  test("invokes signtool with the same flags sign-windows.ps1 uses", async () => {
    const runner = new FakeProcessRunner();
    await signAuthenticode(
      "C:\\out\\installer.exe",
      { certPath: "C:\\certs\\code.pfx", certPassword: "hunter2" },
      runner,
    );
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.command).toBe("signtool");
    expect(runner.calls[0]!.args).toEqual([
      "sign",
      "/f", "C:\\certs\\code.pfx",
      "/p", "hunter2",
      "/fd", "SHA256",
      "/tr", "http://timestamp.digicert.com",
      "/td", "SHA256",
      "C:\\out\\installer.exe",
    ]);
  });

  test("a custom timestamp server overrides the default", async () => {
    const runner = new FakeProcessRunner();
    await signAuthenticode(
      "installer.exe",
      { certPath: "c.pfx", certPassword: "p", timestampServer: "http://ts.example.com" },
      runner,
    );
    expect(runner.calls[0]!.args).toContain("http://ts.example.com");
  });

  test("a nonzero exit is a refusal, not a silent success", async () => {
    const runner = new FakeProcessRunner({ code: 1, signal: null });
    await expect(
      signAuthenticode("installer.exe", { certPath: "c.pfx", certPassword: "p" }, runner),
    ).rejects.toThrow(AuthenticodeSignError);
  });
});
