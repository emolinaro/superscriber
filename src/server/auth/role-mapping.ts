import type { UserRole } from "@/domain/models";

/**
 * Strict Authentik group-to-role mapping (plan section 5).
 *
 * The mounted role map is operator-controlled and contains the exact issuer,
 * the dedicated claim name, and exactly four distinct Authentik group UUIDs.
 * A claim resolves to a role only when it intersects the configured groups in
 * exactly one entry; ambiguity always denies, never picks highest privilege.
 * Local-role agreement is enforced by the caller (admission path).
 */

export type RoleMap = Readonly<{
  version: number;
  issuer: string;
  claim: "superscriber_role_group_ids";
  groups: Readonly<Record<UserRole, string>>;
}>;

export type RoleResolution =
  | { ok: true; role: UserRole; matchedGroupId: string; mapVersion: number }
  | { ok: false; reason: "missing_claim" | "invalid_claim" | "zero_role" | "multi_role" };

export const GROUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hard cap against pathological claims; four configured groups suffice. */
const MAX_CLAIM_GROUPS = 64;

export function resolveMappedRole(claimValue: unknown, map: RoleMap): RoleResolution {
  if (claimValue === undefined || claimValue === null) {
    return { ok: false, reason: "missing_claim" };
  }

  if (!Array.isArray(claimValue) || claimValue.length > MAX_CLAIM_GROUPS) {
    return { ok: false, reason: "invalid_claim" };
  }

  const seen = new Set<string>();
  for (const value of claimValue) {
    if (typeof value !== "string" || !GROUP_ID_PATTERN.test(value) || seen.has(value)) {
      return { ok: false, reason: "invalid_claim" };
    }
    seen.add(value);
  }

  const configured = new Map(
    Object.entries(map.groups).map(([role, groupId]) => [groupId, role as UserRole] as const),
  );

  const matched = (claimValue as string[]).filter((value) => configured.has(value));
  if (matched.length === 0) {
    return { ok: false, reason: "zero_role" };
  }
  if (matched.length > 1) {
    return { ok: false, reason: "multi_role" };
  }

  const matchedGroupId = matched[0];
  return {
    ok: true,
    role: configured.get(matchedGroupId)!,
    matchedGroupId,
    mapVersion: map.version,
  };
}
