import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judge, parseAudit, parseExceptions, type Advisory, type Exception } from "./audit.ts";
import { billOfMaterials, cargoComponents, npmComponents } from "./sbom.ts";

const advisory = (overrides: Partial<Advisory> = {}): Advisory => ({ package: "left-pad", id: "GHSA-aaaa-bbbb-cccc", severity: "high", title: "bad", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", ...overrides });
const exception = (overrides: Partial<Exception> = {}): Exception => ({ advisory: "GHSA-aaaa-bbbb-cccc", package: "left-pad", reason: "not reachable from anything we ship", reviewBy: "2027-01-31", ...overrides });

describe("the dependency gate", () => {
  test("reads the auditor's output into one entry per advisory", () => {
    expect(parseAudit({ "b-pkg": [{ id: 2, url: "https://github.com/advisories/GHSA-zzzz-yyyy-xxxx", title: "two", severity: "Critical" }],
      "a-pkg": [{ id: 1, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", title: "one", severity: "moderate" }, { id: 3, url: "https://example.test/other", title: "three", severity: "high" }, { id: 4, title: "four" }] }))
      .toEqual([{ package: "a-pkg", id: "GHSA-aaaa-bbbb-cccc", severity: "moderate", title: "one", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" },
        // No GHSA ID: kept under its URL. No severity at all: treated as the worst.
        { package: "a-pkg", id: "https://example.test/other", severity: "high", title: "three", url: "https://example.test/other" }, { package: "a-pkg", id: "unidentified:4", severity: "critical", title: "four", url: "" },
        { package: "b-pkg", id: "GHSA-zzzz-yyyy-xxxx", severity: "critical", title: "two", url: "https://github.com/advisories/GHSA-zzzz-yyyy-xxxx" }]);
    expect(parseAudit({})).toEqual([]);
    for (const bad of [null, [], "text", { pkg: "not a list" }]) expect(() => parseAudit(bad)).toThrow();
  });

  test("high and critical block, lower severities are reported, and an unknown severity is treated as the worst", () => {
    const all = ["low", "moderate", "high", "critical", "catastrophic"].map((severity, index) => advisory({ severity, id: `GHSA-aaaa-bbbb-ccc${index}` }));
    const verdict = judge(all, [], "2026-10-11");
    expect(verdict.blocking.map(item => item.severity)).toEqual(["high", "critical", "catastrophic"]); expect(verdict.below.map(item => item.severity)).toEqual(["low", "moderate"]);
    expect(verdict.excepted).toEqual([]); expect(verdict.problems).toEqual([]);
    expect(judge(all, [], "2026-10-11", "low").blocking).toHaveLength(5); expect(() => judge(all, [], "2026-10-11", "severe")).toThrow();
  });

  test("an exception covers one advisory in one package until its date, and not a day longer", () => {
    expect(judge([advisory()], [exception()], "2027-01-31")).toMatchObject({ blocking: [], excepted: [advisory()], problems: [] });
    // The day after: it blocks again, and says why.
    const expired = judge([advisory()], [exception()], "2027-02-01");
    expect(expired.blocking).toEqual([advisory()]); expect(expired.problems).toEqual(["The exception for GHSA-aaaa-bbbb-cccc in left-pad was due for review on 2027-01-31"]);
    // The same advisory in another package, or another advisory in the same package, is not covered.
    expect(judge([advisory({ package: "right-pad" })], [exception()], "2026-10-11").blocking).toHaveLength(1);
    expect(judge([advisory({ id: "GHSA-dddd-eeee-ffff" })], [exception()], "2026-10-11").blocking).toHaveLength(1);
    // An exception left behind after its advisory went away fails the gate too.
    expect(judge([], [exception()], "2026-10-11")).toEqual({ blocking: [], excepted: [], below: [], problems: ["The exception for GHSA-aaaa-bbbb-cccc in left-pad matches no current advisory; remove it"] });
  });

  test("an exception must be a dated decision with a reason", () => {
    expect(parseExceptions([exception()])).toEqual([exception()]);
    for (const bad of [{}, [{}], [{ ...exception(), reason: "" }], [{ ...exception(), reason: "because" }], [{ ...exception(), reviewBy: "soon" }], [{ ...exception(), reviewBy: "2027-13-45" }], [{ ...exception(), advisory: "CVE-2026-1" }],
      [{ ...exception(), package: undefined }], [{ ...exception(), severity: "low" }]]) expect(() => parseExceptions(bad)).toThrow();
  });

  // Whether an exception has expired is the gate's own business, checked where the gate runs. A test here that
  // depended on today's date would fail an unrelated change the morning an exception came due.
  test("the repository's own exceptions file is well formed", () => {
    expect(() => parseExceptions(JSON.parse(readFileSync(join(import.meta.dir, "../../../.config/audit-exceptions.json"), "utf8")))).not.toThrow();
  });
});

describe("the bill of materials", () => {
  const bunLock = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "fixture", "dependencies": { "left-pad": "^1.3.0", }, }, },
  "packages": {
    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-AAEC"],
    "@scope/tool": ["@scope/tool@2.0.0-beta.1", "", { "dependencies": { "left-pad": "^1.3.0" } }, "sha512-/w=="],
    "local": ["local@workspace:packages/local", {}],
    "comma, in name": ["odd@1.0.0", "", {}, "sha256-AQ=="],
  }
}`;
  const cargoLock = `# generated
version = 4

[[package]]
name = "serde"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc123"
dependencies = [
 "serde_derive",
]

[[package]]
name = "carbon-runtime"
version = "0.1.0"
dependencies = [
 "serde",
]

[[package]]
name = "forked"
version = "0.2.0"
source = "git+https://example.test/forked#deadbeef"
`;

  test("lists every pinned package with its version, package URL and the lockfile's own digest", () => {
    expect(npmComponents(bunLock)).toEqual([
      { type: "library", name: "left-pad", version: "1.3.0", purl: "pkg:npm/left-pad@1.3.0", "bom-ref": "pkg:npm/left-pad@1.3.0", hashes: [{ alg: "SHA-512", content: "000102" }] },
      { type: "library", name: "@scope/tool", version: "2.0.0-beta.1", purl: "pkg:npm/%40scope/tool@2.0.0-beta.1", "bom-ref": "pkg:npm/%40scope/tool@2.0.0-beta.1", hashes: [{ alg: "SHA-512", content: "ff" }] },
      { type: "library", name: "odd", version: "1.0.0", purl: "pkg:npm/odd@1.0.0", "bom-ref": "pkg:npm/odd@1.0.0", hashes: [{ alg: "SHA-256", content: "01" }] },
    ]);
    // The repository's own crate has no source and is not something it received; a git dependency has no checksum to give.
    expect(cargoComponents(cargoLock)).toEqual([
      { type: "library", name: "serde", version: "1.0.200", purl: "pkg:cargo/serde@1.0.200", "bom-ref": "pkg:cargo/serde@1.0.200", hashes: [{ alg: "SHA-256", content: "abc123" }] },
      { type: "library", name: "forked", version: "0.2.0", purl: "pkg:cargo/forked@0.2.0", "bom-ref": "pkg:cargo/forked@0.2.0" },
    ]);
  });

  test("the same lockfiles give the same bytes, whatever order the packages were read in", () => {
    const components = [...npmComponents(bunLock), ...cargoComponents(cargoLock)]; const document = billOfMaterials(components);
    expect(billOfMaterials([...components].reverse())).toBe(document);
    const parsed = JSON.parse(document);
    expect(parsed).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1 }); expect(parsed.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parsed.components.map((item: { purl: string }) => item.purl)).toEqual(["pkg:cargo/forked@0.2.0", "pkg:cargo/serde@1.0.200", "pkg:npm/%40scope/tool@2.0.0-beta.1", "pkg:npm/left-pad@1.3.0", "pkg:npm/odd@1.0.0"]);
    expect(document).not.toMatch(/timestamp/);
    // One more package is a different document with a different serial number.
    expect(JSON.parse(billOfMaterials(components.slice(1))).serialNumber).not.toBe(parsed.serialNumber);
  });

  test("the repository's real lockfiles are read in full", () => {
    const root = join(import.meta.dir, "../../..");
    const npm = npmComponents(readFileSync(join(root, ".config/bun.lock"), "utf8")); const cargo = cargoComponents(readFileSync(join(root, ".tools/orchestration/bazel/cargo/Cargo.lock"), "utf8"));
    expect(npm.length).toBeGreaterThan(100); expect(cargo.length).toBeGreaterThan(100);
    // Every npm package has a digest; a registry crate has one too.
    expect(npm.filter(item => !item.hashes)).toEqual([]); expect(cargo.filter(item => item.hashes).length).toBeGreaterThan(cargo.length * 0.9);
    for (const name of ["vite", "react", "ajv"]) expect([name, npm.some(item => item.name === name)]).toEqual([name, true]);
  });
});
