import { describe, expect, test } from "bun:test";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "@carbon/process";
import {
  signAndNotarizeMacOs,
  CodesignError,
  NotarizeError,
  StapleError,
} from "../index.ts";

class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  private readonly results: Record<string, ProcessResult>;
  constructor(overrides: Partial<Record<string, ProcessResult>> = {}) {
    this.results = { codesign: { code: 0, signal: null }, xcrun: { code: 0, signal: null }, ...overrides };
  }
  async run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    return this.results[command]!;
  }
}

const credentials = { developerId: "Developer ID Application: Acme", appleId: "a@b.com", appPassword: "p", teamId: "T1" };

describe("signAndNotarizeMacOs", () => {
  test("codesigns, submits for notarization, then staples — in that order", async () => {
    const runner = new FakeProcessRunner();
    await signAndNotarizeMacOs("/out/carbon-mini", credentials, runner);

    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[0]!.command).toBe("codesign");
    expect(runner.calls[0]!.args).toEqual([
      "--force", "--options", "runtime", "--timestamp",
      "--sign", credentials.developerId,
      "/out/carbon-mini",
    ]);

    expect(runner.calls[1]!.command).toBe("xcrun");
    expect(runner.calls[1]!.args).toEqual([
      "notarytool", "submit", "/out/carbon-mini",
      "--apple-id", credentials.appleId,
      "--password", credentials.appPassword,
      "--team-id", credentials.teamId,
      "--wait",
    ]);

    expect(runner.calls[2]!.command).toBe("xcrun");
    expect(runner.calls[2]!.args).toEqual(["stapler", "staple", "/out/carbon-mini"]);
  });

  test("a codesign failure stops before notarizing", async () => {
    const runner = new FakeProcessRunner({ codesign: { code: 1, signal: null } });
    await expect(signAndNotarizeMacOs("/f", credentials, runner)).rejects.toThrow(CodesignError);
    expect(runner.calls).toHaveLength(1);
  });

  test("a notarization failure stops before stapling", async () => {
    const runner = new FakeProcessRunner();
    let call = 0;
    runner.run = async (command, args, options) => {
      call++;
      runner.calls.push({ command, args, options });
      if (command === "xcrun" && call === 2) return { code: 1, signal: null };
      return { code: 0, signal: null };
    };
    await expect(signAndNotarizeMacOs("/f", credentials, runner)).rejects.toThrow(NotarizeError);
    expect(runner.calls).toHaveLength(2);
  });

  test("a staple failure is still reported, not swallowed", async () => {
    const runner = new FakeProcessRunner();
    let call = 0;
    runner.run = async (command, args, options) => {
      call++;
      runner.calls.push({ command, args, options });
      if (call === 3) return { code: 1, signal: null };
      return { code: 0, signal: null };
    };
    await expect(signAndNotarizeMacOs("/f", credentials, runner)).rejects.toThrow(StapleError);
  });
});
