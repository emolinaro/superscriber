import { redirect } from "next/navigation";
import { BootstrapSetupForm } from "@/components/auth/bootstrap-setup-form";
import { LoginForm } from "@/components/auth/login-form";
import { hasAnyUsers } from "@/server/auth/service";
import { getActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function renderAuthNotice(reason: string | undefined, notice: string | undefined) {
  if (notice === "bootstrap-complete") {
    return (
      <div className="banner" data-tone="ok">
        First-run setup is complete. Sign in with the admin account you just created.
      </div>
    );
  }

  if (reason === "logged-out") {
    return (
      <div className="banner" data-tone="ok">
        Your session ended safely. Sign in again when you want to continue.
      </div>
    );
  }

  if (reason === "session-expired") {
    return (
      <div className="banner" data-tone="danger">
        Session expired. Sign in again to continue.
      </div>
    );
  }

  return null;
}

export default async function LandingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const principal = await getActivePrincipal();
  if (principal) {
    redirect("/workspace");
  }

  const params = await searchParams;
  const anyUsers = await hasAnyUsers();
  const notice = firstValue(params.notice);
  const reason = firstValue(params.reason);

  return (
    <main className="shell">
      <div className="hero-grid">
        <section className="panel panel-dark">
          <div className="panel-inner stack">
            <p className="eyebrow">Superscriber</p>
            <h1 className="headline">One governed workspace for sensitive recordings.</h1>
            <p className="lede" style={{ color: "rgba(238, 246, 242, 0.8)" }}>
              Local accounts now gate the workspace. The media pipeline is still
              moving off the prototype stack, but the trust boundary has shifted to
              real sign-in, explicit session expiry, and server-side role access.
            </p>
            <div className="button-row">
              <span className="pill" data-tone={anyUsers ? "ok" : "warn"}>
                {anyUsers ? "Local login active" : "First-run setup required"}
              </span>
              <span className="pill" data-tone="info">
                Browser-bound review
              </span>
              <span className="pill" data-tone="ok">
                Raw media stays server-side
              </span>
            </div>
          </div>
        </section>

        <section className="panel panel-strong">
          <div className="panel-inner stack">
            <p className="eyebrow">{anyUsers ? "Local sign-in" : "First-run setup"}</p>
            <h2 className="section-title">
              {anyUsers
                ? "Sign in to continue inside the governed workspace."
                : "Create the first administrator before normal login opens."}
            </h2>
            <p className="body-copy">
              {anyUsers
                ? "Use the local account assigned by your institution. Wrong-password and session-expiry states stay explicit."
                : "This appliance is not ready for daily use until the first admin exists. Setup only has to happen once."}
            </p>
            {renderAuthNotice(reason, notice)}
            {anyUsers ? <LoginForm /> : <BootstrapSetupForm />}
          </div>
        </section>
      </div>
    </main>
  );
}
