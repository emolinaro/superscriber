/**
 * Per-tab marker for intentional sign-out. The session guard (AppShell) skips
 * its session-expired redirect while a deliberate sign-out is in flight, so
 * the user reliably lands on the logged-out surface instead of racing the
 * poller. The marker is cleared when the authenticated shell mounts again
 * (that is, after the next successful sign-in in this tab).
 */
export const SIGNED_OUT_MARKER_KEY = "superscriber:signed-out";

export function markIntentionalSignOut() {
  try {
    window.sessionStorage.setItem(SIGNED_OUT_MARKER_KEY, "1");
  } catch {
    // Storage unavailable: worst case is the rare redirect race this marker
    // exists to prevent.
  }
}

export function hasIntentionalSignOut(): boolean {
  try {
    return window.sessionStorage.getItem(SIGNED_OUT_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearIntentionalSignOut() {
  try {
    window.sessionStorage.removeItem(SIGNED_OUT_MARKER_KEY);
  } catch {
    // See markIntentionalSignOut.
  }
}
