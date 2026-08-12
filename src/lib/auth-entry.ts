import type { SignUpSurface } from "@/lib/auth-surface-model";

export type AuthEntry = "signup" | "signin";

/**
 * Strict validation of the `entry` search param that drives the no-JavaScript
 * door links on the auth landing page. Anything other than the two exact
 * door keys falls back to the server-chosen default.
 */
export function parseAuthEntryParam(value: string | undefined): AuthEntry | null {
  return value === "signup" || value === "signin" ? value : null;
}

/**
 * Which door opens on the auth landing page. Forced server states win over
 * the `entry` param exactly as they won over client toggles before:
 * - bootstrap-complete / admin-recovery-complete notices force Sign in (the
 *   visitor must sign in with the account they just created);
 * - first-run setup and the recovery surfaces force Sign up (that door is
 *   the only actionable path).
 * In the provisioned steady state the param wins, so the no-JS door links
 * round-trip to the pane the visitor actually asked for.
 */
export function resolveAuthEntry(options: {
  requested: AuthEntry | null;
  completedNotice: boolean;
  signUpSurface: SignUpSurface;
}): AuthEntry {
  const { requested, completedNotice, signUpSurface } = options;
  if (completedNotice) {
    return "signin";
  }
  if (signUpSurface !== "provisioned") {
    return "signup";
  }
  return requested ?? "signin";
}

/**
 * Build the href for a door link: the landing page with every current search
 * param preserved and `entry` set to the door's key. Preserving returnTo /
 * notice / error / reason keeps the no-JS navigation behaving like the
 * client-side toggle it stands in for (the notice banner and the return
 * path survive the door switch).
 */
export function buildAuthEntryHref(
  params: Record<string, string | string[] | undefined>,
  entry: AuthEntry,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "entry" || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, item);
      }
    } else {
      search.append(key, value);
    }
  }
  search.set("entry", entry);
  return `/?${search.toString()}`;
}
