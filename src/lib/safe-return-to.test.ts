import { describe, expect, it } from "vitest";
import { sanitizeReturnTo } from "./safe-return-to";

describe("sanitizeReturnTo", () => {
  it.each([
    ["/workspace", "/workspace"],
    ["/workspace?tab=waiting&sort=updated_asc", "/workspace?tab=waiting&sort=updated_asc"],
    ["/recordings/rec-1?revision=rev-1", "/recordings/rec-1?revision=rev-1"],
    ["https://evil.test", "/workspace"],
    ["//evil.test/path", "/workspace"],
    ["/administration?section=unknown", "/workspace"],
  ])("sanitizes %s", (value, expected) => {
    expect(sanitizeReturnTo(value)).toBe(expected);
  });

  it("rejects credentials, unknown routes, and unknown query keys", () => {
    expect(sanitizeReturnTo("https://user:pass@superscriber.local/workspace")).toBe(
      "/workspace",
    );
    expect(sanitizeReturnTo("/workspace?tab=waiting&unsafe=1")).toBe("/workspace");
    expect(sanitizeReturnTo("/recordings/rec-1/extra")).toBe("/workspace");
    expect(sanitizeReturnTo("/unknown")).toBe("/workspace");
  });
});
