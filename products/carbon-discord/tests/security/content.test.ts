import { describe, expect, test } from "bun:test";
import { redactSecrets, safeUserText } from "../../presentation/security/content.ts";

describe("Discord user content safety", () => {
  test("redacts credentials before content is stored or exported", () => {
    expect(redactSecrets("token cc_1234567890secret and Bearer abc.def.ghi")).toBe("token [REDACTED SECRET] and [REDACTED SECRET]");
  });

  test("neutralizes mass mentions and enforces a length bound", () => {
    const result = safeUserText("@everyone hello @here", 20);
    expect(result).not.toContain("@everyone");
    expect(result).not.toContain("@here");
    expect(result.length).toBeLessThanOrEqual(20);
  });
});
