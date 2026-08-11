import { describe, expect, it } from "vitest";
import {
  buildAuthNotice,
  resolveAuthSurfaceModel,
  resolveSignUpSurface,
} from "@/lib/auth-surface-model";

describe("auth surface model", () => {
  it("local mode shows only the credentials form", () => {
    expect(resolveAuthSurfaceModel({ mode: "local", zone: "public" })).toEqual({
      showLocalCredentialsForm: true,
      showOidcSignIn: false,
      showBreakGlassDisclosure: false,
    });
  });

  it("dual mode shows institutional sign-in next to the local form; disclosure only on management", () => {
    expect(resolveAuthSurfaceModel({ mode: "dual", zone: "public" })).toEqual({
      showLocalCredentialsForm: true,
      showOidcSignIn: true,
      showBreakGlassDisclosure: false,
    });
    expect(resolveAuthSurfaceModel({ mode: "dual", zone: "management" })).toEqual({
      showLocalCredentialsForm: true,
      showOidcSignIn: true,
      showBreakGlassDisclosure: true,
    });
  });

  it("classifies the sign-up door by account and active-admin presence", () => {
    expect(
      resolveSignUpSurface({ anyUsers: false, anyActiveAdmin: false, mode: "local" }),
    ).toBe("first-run");
    expect(
      resolveSignUpSurface({ anyUsers: true, anyActiveAdmin: true, mode: "local" }),
    ).toBe("provisioned");
    expect(
      resolveSignUpSurface({ anyUsers: true, anyActiveAdmin: false, mode: "local" }),
    ).toBe("recovery");
    expect(
      resolveSignUpSurface({ anyUsers: true, anyActiveAdmin: false, mode: "dual" }),
    ).toBe("recovery");
  });

  it("steers an unmanageable authentik-primary appliance to the break-glass runbook", () => {
    // A locally claimed admin cannot sign in when institutional sign-in is
    // primary, so the claim ceremony is withheld there.
    expect(
      resolveSignUpSurface({
        anyUsers: true,
        anyActiveAdmin: false,
        mode: "authentik-primary",
      }),
    ).toBe("recovery-break-glass");
    expect(
      resolveSignUpSurface({ anyUsers: false, anyActiveAdmin: false, mode: "authentik-primary" }),
    ).toBe("first-run");
  });

  it("returns the recovery completion notice", () => {
    expect(buildAuthNotice(undefined, "admin-recovery-complete", undefined)).toEqual({
      tone: "ok",
      message:
        "Administrator recovery is complete. Sign in with the admin account you just claimed.",
      focusHeading: true,
    });
  });

  it("returns the forced re-login notice for a completed account role change", () => {
    expect(buildAuthNotice("role-changed", undefined, undefined)).toEqual({
      tone: "ok",
      message: "Your account role changed. Sign in again to continue.",
      focusHeading: true,
    });
  });

  it("authentik-primary hides the local form and gates the disclosure on management zone", () => {
    expect(resolveAuthSurfaceModel({ mode: "authentik-primary", zone: "public" })).toEqual({
      showLocalCredentialsForm: false,
      showOidcSignIn: true,
      showBreakGlassDisclosure: false,
    });
    expect(resolveAuthSurfaceModel({ mode: "authentik-primary", zone: "management" })).toEqual({
      showLocalCredentialsForm: false,
      showOidcSignIn: true,
      showBreakGlassDisclosure: true,
    });
  });
});
