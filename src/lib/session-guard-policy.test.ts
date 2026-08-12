// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearIntentionalSignOut,
  markIntentionalSignOut,
  SIGNED_OUT_MARKER_KEY,
} from "@/lib/signed-out-marker";
import {
  clearSelfResetHold,
  markSelfResetHold,
  SELF_RESET_HOLD_KEY,
} from "@/lib/self-reset-hold";
import {
  shouldHoldSessionExpiredRedirect,
  shouldRedirectInactiveSession,
} from "@/lib/session-guard-policy";

afterEach(() => {
  window.sessionStorage.clear();
});

describe("shouldHoldSessionExpiredRedirect", () => {
  it("does not hold when no markers are set", () => {
    expect(shouldHoldSessionExpiredRedirect()).toBe(false);
  });

  it("holds during an intentional sign-out", () => {
    markIntentionalSignOut();
    expect(shouldHoldSessionExpiredRedirect()).toBe(true);
  });

  it("holds while a self-reset result dialog is open", () => {
    markSelfResetHold();
    expect(shouldHoldSessionExpiredRedirect()).toBe(true);
  });

  it("stops holding once the self-reset dialog clears the hold", () => {
    markSelfResetHold();
    clearSelfResetHold();
    expect(shouldHoldSessionExpiredRedirect()).toBe(false);
  });

  it("stops holding once an intentional sign-out completes", () => {
    markIntentionalSignOut();
    clearIntentionalSignOut();
    expect(shouldHoldSessionExpiredRedirect()).toBe(false);
  });

  it("keeps unrelated session storage entries out of the decision", () => {
    window.sessionStorage.setItem(`${SELF_RESET_HOLD_KEY}-other`, "1");
    window.sessionStorage.setItem(`${SIGNED_OUT_MARKER_KEY}-other`, "1");
    expect(shouldHoldSessionExpiredRedirect()).toBe(false);
  });

  it("rechecks the hold before redirecting an inactive session", () => {
    expect(shouldRedirectInactiveSession({ active: false, cancelled: false })).toBe(true);
    markSelfResetHold();
    expect(shouldRedirectInactiveSession({ active: false, cancelled: false })).toBe(false);
  });
});
