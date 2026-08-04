import type { AuthMode } from "@/server/auth/auth-config";
import type { SourceZone } from "@/server/auth/management-network";

/**
 * Sign-in surface composition per auth mode and source zone (plan 8.2):
 * - local: credentials form only
 * - dual: institutional sign-in next to the local form
 * - dual and authentik-primary: the emergency local administrator disclosure
 *   renders only through the trusted management boundary
 */
export type AuthSurfaceModel = {
  showLocalCredentialsForm: boolean;
  showOidcSignIn: boolean;
  showBreakGlassDisclosure: boolean;
};

export function resolveAuthSurfaceModel(input: {
  mode: AuthMode;
  zone: SourceZone;
}): AuthSurfaceModel {
  if (input.mode === "local") {
    return {
      showLocalCredentialsForm: true,
      showOidcSignIn: false,
      showBreakGlassDisclosure: false,
    };
  }

  if (input.mode === "dual") {
    return {
      showLocalCredentialsForm: true,
      showOidcSignIn: true,
      // The emergency ceremony is reachable in dual and primary modes, always
      // gated to the trusted management boundary.
      showBreakGlassDisclosure: input.zone === "management",
    };
  }

  return {
    showLocalCredentialsForm: false,
    showOidcSignIn: true,
    showBreakGlassDisclosure: input.zone === "management",
  };
}
