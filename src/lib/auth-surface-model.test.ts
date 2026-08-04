import { describe, expect, it } from "vitest";
import { resolveAuthSurfaceModel } from "@/lib/auth-surface-model";

describe("auth surface model", () => {
  it("local mode shows only the credentials form", () => {
    expect(resolveAuthSurfaceModel({ mode: "local", zone: "public" })).toEqual({
      showLocalCredentialsForm: true,
      showOidcSignIn: false,
      showBreakGlassDisclosure: false,
    });
  });

  it("dual mode shows institutional sign-in next to the local form, no disclosure", () => {
    expect(resolveAuthSurfaceModel({ mode: "dual", zone: "management" })).toEqual({
      showLocalCredentialsForm: true,
      showOidcSignIn: true,
      showBreakGlassDisclosure: false,
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
