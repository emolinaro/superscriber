import { hasIntentionalSignOut } from "@/lib/signed-out-marker";
import { hasSelfResetHold } from "@/lib/self-reset-hold";

/**
 * Session-guard redirect policy (plan section 7.3). The guard converges an
 * open UI to the sign-in door within five seconds of a revoked or expired
 * session, except when the tab is deliberately holding that redirect: an
 * intentional sign-out in flight, or a self-reset result dialog that must
 * keep the one-shot link on screen until the operator dismisses it.
 */
export function shouldHoldSessionExpiredRedirect(): boolean {
  return hasIntentionalSignOut() || hasSelfResetHold();
}

export function shouldRedirectInactiveSession({
  active,
  cancelled,
}: {
  active?: boolean;
  cancelled: boolean;
}): boolean {
  return !cancelled && active === false && !shouldHoldSessionExpiredRedirect();
}
