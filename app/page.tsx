import { cookies, headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthTabs } from "@/components/auth/auth-tabs";
import { AuthPaneHeading } from "@/components/auth/auth-pane-heading";
import { EmergencyAccess } from "@/components/auth/emergency-access";
import { BootstrapSetupForm } from "@/components/auth/bootstrap-setup-form";
import { LoginForm } from "@/components/auth/login-form";
import { OidcSignInButton } from "@/components/auth/oidc-sign-in-button";
import { SuperscriberLogo } from "@/components/brand/superscriber-logo";
import { sanitizeReturnTo } from "@/lib/safe-return-to";
import {
  buildAuthNotice,
  resolveAuthSurfaceModel,
} from "@/lib/auth-surface-model";
import { loadAuthConfig, type AuthMode } from "@/server/auth/auth-config";
import {
  evaluateSourceZone,
  loadManagementNetworkPolicy,
  type SourceZone,
} from "@/server/auth/management-network";
import { hasAnyUsers } from "@/server/auth/service";
import { getActivePrincipal, resolveAuthorizedReturnTo } from "@/server/session";

export const dynamic = "force-dynamic";

const BOOTSTRAP_EMAIL_COOKIE = "superscriber.bootstrap-email";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function modeFactPill(mode: AuthMode) {
  switch (mode) {
    case "dual":
      return "Dual mode: institution or local sign-in";
    case "authentik-primary":
      return "Institutional sign-in is primary";
    default:
      return "Local credentials only";
  }
}

export default async function LandingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const requestedReturnTo = sanitizeReturnTo(firstValue(params.returnTo));
  const principal = await getActivePrincipal();
  if (principal) {
    redirect(resolveAuthorizedReturnTo(principal, requestedReturnTo));
  }

  const anyUsers = await hasAnyUsers();
  const authMode = loadAuthConfig().mode;

  // The management boundary governs whether the emergency break-glass
  // disclosure renders at all (plan 8.2). Without a mounted policy (or an
  // unreadable one) the zone fails closed to public.
  let zone: SourceZone = "public";
  const policyPath = process.env.SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE?.trim();
  if (policyPath && authMode !== "local") {
    try {
      zone = evaluateSourceZone(await headers(), loadManagementNetworkPolicy(policyPath)).zone;
    } catch {
      zone = "public";
    }
  }
  const surface = resolveAuthSurfaceModel({ mode: authMode, zone });
  const notice = buildAuthNotice(
    firstValue(params.reason),
    firstValue(params.notice),
    firstValue(params.error),
  );
  const cookieStore = await cookies();
  const bootstrapEmail = cookieStore.get(BOOTSTRAP_EMAIL_COOKIE)?.value ?? "";
  const readiness = anyUsers
    ? null
    : await import("@/server/bootstrap/readiness").then((module) =>
        module.getBootstrapReadiness(),
      );

  // Explicit two-door model (demo sign-in restyle, replayed onto the branded
  // surface): Sign up is first-time persona admission (the first-admin
  // ceremony, or the provisioned-access explanation once the envelope
  // exists); Sign in serves returning users.
  const initialEntry =
    anyUsers || firstValue(params.notice) === "bootstrap-complete" ? "signin" : "signup";

  // Server-rendered notices (session expired, forced re-login, bootstrap
  // complete, ...) request heading focus; the visible pane's heading is the
  // orienting target, matching the pre-restyle surface contract.
  const focusHeading = notice?.focusHeading ?? false;

  const signUpPane = anyUsers ? (
    <div className="stack auth-pane">
      <div className="stack-tight">
        <AuthPaneHeading focusOnMount={focusHeading && initialEntry === "signup"}>
          First-time access
        </AuthPaneHeading>
        <p className="body-copy">
          Superscriber has no self-service sign-up. An administrator provisions accounts from
          Administration &gt; Accounts, and institutionally managed people are admitted through the
          institution sign-in once their identity is linked.
        </p>
      </div>
      <p className="field-note">
        Already provisioned - locally or by your institution? Choose <strong>Sign in</strong> above.
      </p>
    </div>
  ) : readiness ? (
    <div className="stack auth-pane">
      <div className="stack-tight">
        <AuthPaneHeading focusOnMount={focusHeading && initialEntry === "signup"}>
          First-run setup
        </AuthPaneHeading>
        <p className="body-copy">
          Create the first administrator after the appliance passes the local readiness checks.
        </p>
      </div>
      <BootstrapSetupForm readiness={readiness} />
    </div>
  ) : null;

  const signInPane = anyUsers ? (
    <div className="stack auth-pane">
      <div className="stack-tight">
        <AuthPaneHeading focusOnMount={focusHeading && initialEntry === "signin"}>
          Sign in
        </AuthPaneHeading>
        <p className="body-copy">
          Use your local institution account to reopen the governed workspace.
        </p>
      </div>
      {surface.showOidcSignIn ? <OidcSignInButton returnTo={requestedReturnTo} /> : null}
      {surface.showLocalCredentialsForm ? (
        <>
          <LoginForm initialEmail={bootstrapEmail} returnTo={requestedReturnTo} />
          <p className="auth-links">
            <Link href="/reset-request">Forgot your password?</Link>
          </p>
        </>
      ) : null}
      {surface.showBreakGlassDisclosure ? <EmergencyAccess /> : null}
    </div>
  ) : (
    <div className="stack auth-pane">
      <div className="stack-tight">
        <AuthPaneHeading focusOnMount={focusHeading && initialEntry === "signin"}>
          Sign in
        </AuthPaneHeading>
        <p className="body-copy">
          No accounts exist on this appliance yet. Create the first administrator under Sign up,
          then return here.
        </p>
      </div>
    </div>
  );

  return (
    <main className="shell shell-auth">
      <div className="auth-hero">
        <section className="panel auth-hero__brand">
          <div className="panel-inner stack auth-hero__brand-inner">
            <SuperscriberLogo
              className="auth-hero__logo"
              showDescriptor
              size="lg"
              tone="inverse"
            />
            <div className="stack-tight">
              <p className="eyebrow auth-hero__eyebrow">Governed appliance access</p>
              <h1 className="auth-hero__headline">
                One governed workspace for sensitive recordings.
              </h1>
              <p className="auth-hero__lede">
                Sign-in, logout, and session recovery stay on this appliance. Access is checked
                again after every successful sign-in, return paths stay on approved workspace
                routes, and raw media never leaves the server.
              </p>
            </div>
            <ul className="auth-hero__facts">
              <li className="pill">{modeFactPill(authMode)}</li>
              <li className="pill">Raw media stays server-side</li>
              <li className="pill">No-mail deployment</li>
            </ul>
          </div>
        </section>

        <section className="panel panel-strong auth-card">
          <div className="panel-inner stack">
            <div className="stack-tight">
              <p className="eyebrow">Account access</p>
              <p className="body-copy">
                Two doors, one workspace: first-time admission under Sign up, returning access
                under Sign in.
              </p>
            </div>
            {notice ? (
              <p className="banner" data-tone={notice.tone} role={notice.tone === "danger" ? "alert" : "status"}>
                {notice.message}
              </p>
            ) : null}
            <AuthTabs
              initialEntry={initialEntry}
              signInPane={signInPane}
              signUpPane={signUpPane}
            />
            <ul className="auth-support-list auth-card__notes field-note">
              <li>Return paths are limited to approved workspace routes.</li>
              <li>Access is checked again after every successful sign-in.</li>
              <li>Passwords are cleared after every failed attempt.</li>
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}
