/**
 * Per-tab hold for the self-reset result dialog. Issuing a password reset for
 * your own account revokes every session, including the current one. The
 * result dialog must stay open so the operator can copy the one-shot link, so
 * the session guard (AppShell) skips its session-expired redirect while this
 * hold is set. The dialog clears the hold when it closes (or unmounts); the
 * shell also clears any stale hold when an authenticated shell mounts.
 */
export const SELF_RESET_HOLD_KEY = "superscriber:self-reset-hold";

export function markSelfResetHold() {
  try {
    window.sessionStorage.setItem(SELF_RESET_HOLD_KEY, "1");
  } catch {
    // Storage unavailable: worst case the session guard bounces the tab early,
    // which is the behavior this hold exists to prevent.
  }
}

export function hasSelfResetHold(): boolean {
  try {
    return window.sessionStorage.getItem(SELF_RESET_HOLD_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearSelfResetHold() {
  try {
    window.sessionStorage.removeItem(SELF_RESET_HOLD_KEY);
  } catch {
    // See markSelfResetHold.
  }
}
