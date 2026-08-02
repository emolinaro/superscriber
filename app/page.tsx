import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthSurface } from "@/components/auth/auth-surface";
import { BootstrapSetupForm } from "@/components/auth/bootstrap-setup-form";
import { LoginForm } from "@/components/auth/login-form";
import { sanitizeReturnTo } from "@/lib/safe-return-to";
import { hasAnyUsers } from "@/server/auth/service";
import { getActivePrincipal, resolveAuthorizedReturnTo } from "@/server/session";

export const dynamic = "force-dynamic";

const BOOTSTRAP_EMAIL_COOKIE = "superscriber.bootstrap-email";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function buildNotice(reason: string | undefined, notice: string | undefined) {
  if (notice === "bootstrap-complete") {
    return {
      tone: "ok" as const,
      message: "First-run setup is complete. Sign in with the admin account you just created.",
      focusHeading: true,
    };
  }

  if (reason === "logged-out") {
    return {
      tone: "ok" as const,
      message: "Your session ended safely.",
      focusHeading: true,
    };
  }

  if (reason === "session-expired") {
    return {
      tone: "danger" as const,
      message: "Session expired. Sign in again to continue.",
      focusHeading: true,
    };
  }

  return null;
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
  const notice = buildNotice(firstValue(params.reason), firstValue(params.notice));
  const cookieStore = await cookies();
  const bootstrapEmail = cookieStore.get(BOOTSTRAP_EMAIL_COOKIE)?.value ?? "";
  const readiness = anyUsers
    ? null
    : await import("@/server/bootstrap/readiness").then((module) =>
        module.getBootstrapReadiness(),
      );

  return (
    <main className="shell shell-auth">
      <AuthSurface
        description={
          anyUsers
            ? "Use your local institution account to reopen the governed workspace."
            : "Create the first administrator after the appliance passes the local readiness checks."
        }
        focusHeading={notice?.focusHeading ?? false}
        heading={anyUsers ? "Sign in" : "First-run setup"}
        notice={notice ?? undefined}
        support={
          anyUsers ? (
            <>
              <h2 className="card-title">Safe sign-in</h2>
              <p className="field-note">
                Local credentials stay on this appliance. Sign-in, logout, and session recovery
                are available on phone-sized screens.
              </p>
              <ul className="auth-support-list">
                <li>Return paths are limited to approved workspace routes.</li>
                <li>Access is checked again after every successful sign-in.</li>
                <li>Passwords are cleared after every failed attempt.</li>
              </ul>
            </>
          ) : (
            <>
              <h2 className="card-title">Setup notes</h2>
              <p className="field-note">
                First-run setup opens once. After the first admin is created, normal sign-in takes
                over for all governed roles.
              </p>
              <ul className="auth-support-list">
                <li>Only safe readiness details are shown here.</li>
                <li>Passwords are never preserved after an error.</li>
                <li>Uploads and media stay on the server.</li>
              </ul>
            </>
          )
        }
      >
        {anyUsers ? (
          <LoginForm initialEmail={bootstrapEmail} returnTo={requestedReturnTo} />
        ) : readiness ? (
          <BootstrapSetupForm readiness={readiness} />
        ) : null}
      </AuthSurface>
    </main>
  );
}
