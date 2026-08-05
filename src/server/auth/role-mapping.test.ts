import { describe, expect, it } from "vitest";
import { resolveMappedRole, type RoleMap } from "@/server/auth/role-mapping";

const GROUPS = {
  uploader: "11111111-1111-4111-8111-111111111111",
  reviewer: "22222222-2222-4222-8222-222222222222",
  approver: "33333333-3333-4333-8333-333333333333",
  admin: "44444444-4444-4444-8444-444444444444",
} as const;

const MAP: RoleMap = {
  version: 3,
  issuer: "https://auth.example.com/application/o/superscriber/",
  claim: "superscriber_role_group_ids",
  groups: GROUPS,
};

describe("resolveMappedRole", () => {
  it("resolves exactly one configured group to its role with the map version", () => {
    expect(
      resolveMappedRole(
        ["99999999-9999-4999-8999-999999999999", GROUPS.approver],
        MAP,
      ),
    ).toEqual({
      ok: true,
      role: "approver",
      matchedGroupId: GROUPS.approver,
      mapVersion: 3,
    });
  });

  it("denies when the claim is absent or not an array", () => {
    expect(resolveMappedRole(undefined, MAP)).toEqual({ ok: false, reason: "missing_claim" });
    expect(resolveMappedRole(null, MAP)).toEqual({ ok: false, reason: "missing_claim" });
    expect(resolveMappedRole(GROUPS.admin, MAP)).toEqual({ ok: false, reason: "invalid_claim" });
    expect(resolveMappedRole(42, MAP)).toEqual({ ok: false, reason: "invalid_claim" });
  });

  it("denies malformed, oversized, or duplicate claims", () => {
    expect(resolveMappedRole(["not-a-uuid"], MAP)).toEqual({ ok: false, reason: "invalid_claim" });
    expect(resolveMappedRole([GROUPS.admin, GROUPS.admin], MAP)).toEqual({
      ok: false,
      reason: "invalid_claim",
    });
    expect(resolveMappedRole(new Array(65).fill(GROUPS.admin), MAP)).toEqual({
      ok: false,
      reason: "invalid_claim",
    });
    expect(resolveMappedRole([GROUPS.admin.toUpperCase() + "x"], MAP)).toEqual({
      ok: false,
      reason: "invalid_claim",
    });
  });

  it("denies when the claim intersects zero configured groups", () => {
    expect(resolveMappedRole([], MAP)).toEqual({ ok: false, reason: "zero_role" });
    expect(
      resolveMappedRole(["99999999-9999-4999-8999-999999999999"], MAP),
    ).toEqual({ ok: false, reason: "zero_role" });
  });

  it("denies when more than one configured group matches; it never picks highest privilege", () => {
    expect(resolveMappedRole([GROUPS.reviewer, GROUPS.admin], MAP)).toEqual({
      ok: false,
      reason: "multi_role",
    });
    expect(resolveMappedRole([GROUPS.admin, GROUPS.uploader, GROUPS.approver], MAP)).toEqual({
      ok: false,
      reason: "multi_role",
    });
  });
});
