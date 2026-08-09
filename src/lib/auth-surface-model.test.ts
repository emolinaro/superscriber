import { describe, expect, it } from "vitest";
import {
  buildAuthNotice,
  resolveAuthSurfaceModel,
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
