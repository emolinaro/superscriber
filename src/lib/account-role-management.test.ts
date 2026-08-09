import { describe, expect, it } from "vitest";
import {
  CHANGE_REASON_MAX,
  CHANGE_REASON_MIN,
  changeAccountRoleInputSchema,
} from "./account-role-management";

const valid = {
  userId: "user-1",
  expectedRole: "reviewer",
  newRole: "approver",
  reason: "Role duties changed.",
} as const;

describe("changeAccountRoleInputSchema", () => {
  it("trims and accepts a valid role change", () => {
    expect(
      changeAccountRoleInputSchema.parse({
        ...valid,
        reason: "  Role duties changed.  ",
      }),
    ).toEqual(valid);
  });

  it.each([
    {
      label: "a reason below the minimum",
      input: { ...valid, reason: "x".repeat(CHANGE_REASON_MIN - 1) },
      field: "reason",
    },
    {
      label: "a reason above the maximum",
      input: { ...valid, reason: "x".repeat(CHANGE_REASON_MAX + 1) },
      field: "reason",
    },
    {
      label: "an unknown role",
      input: { ...valid, newRole: "owner" },
      field: "newRole",
    },
    {
      label: "a no-op role selection",
      input: { ...valid, newRole: "reviewer" },
      field: "newRole",
    },
    {
      label: "an unknown authority key",
      input: { ...valid, extraAuthority: "admin" },
      field: null,
    },
  ])("rejects $label", ({ input, field }) => {
    const result = changeAccountRoleInputSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success && field) {
      expect(result.error.flatten().fieldErrors).toHaveProperty(field);
    }
  });
});
