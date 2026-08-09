import type { AuthMode } from "@/server/auth/auth-config";
import type { SourceZone } from "@/server/auth/management-network";

/**
 * Sign-in surface composition per auth mode and source zone (plan 8.2):
 * - local: credentials form only
 * - dual: institutional sign-in next to the local form
 * - dual and authentik-primary: the emergency local administrator disclosure
 *   renders only through the trusted management boundary
 */
export type AuthNotice = {
  tone: "ok" | "danger";
  message: string;
  focusHeading: boolean;
};

export function buildAuthNotice(
  reason: string | undefined,
  notice: string | undefined,
  error: string | undefined,
): AuthNotice | null {
  if (error) {
    return {
      tone: "danger",
      message:
        "Access is not provisioned for this account, or sign-in could not be completed. Contact an administrator.",
      focusHeading: true,
    };
  }
  if (notice === "bootstrap-complete") {
    return {
      tone: "ok",
      message:
        "First-run setup is complete. Sign in with the admin account you just created.",
      focusHeading: true,
    };
  }
  if (reason === "logged-out") {
    return {
      tone: "ok",
      message: "Your session ended safely.",
      focusHeading: true,
    };
  }
  if (reason === "session-expired") {
    return {
      tone: "danger",
      message: "Session expired. Sign in again to continue.",
      focusHeading: true,
    };
  }
  if (reason === "role-changed") {
    return {
      tone: "ok",
      message: "Your account role changed. Sign in again to continue.",
      focusHeading: true,
    };
  }
  return null;
}

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
