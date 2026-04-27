import { redirect } from "next/navigation";
import { enterWorkspaceAction } from "@/app/actions";
import { USER_ROLES } from "@/domain/models";
import { getActiveRole } from "@/server/session";

export const dynamic = "force-dynamic";

const ROLE_COPY: Record<
  (typeof USER_ROLES)[number],
  { title: string; description: string; badge: string }
> = {
  uploader: {
    title: "Capture and ingest",
    description:
      "Use the governed entry point to upload or record sensitive material directly into the institutional workspace.",
    badge: "Ingest role",
  },
  reviewer: {
    title: "Review and correct",
    description:
      "Listen in the browser, verify diarization, and correct transcript text without pulling media onto a local device.",
    badge: "Review role",
  },
  approver: {
    title: "Approve and control release",
    description:
      "Lock approved transcripts, reopen when policy allows, and govern who can export approved text.",
    badge: "Approval role",
  },
  admin: {
    title: "Oversee governed flow",
    description:
      "Inspect the entire pipeline, switch roles for support, and validate the policy profile across every queue.",
    badge: "Admin role",
  },
};

export default async function LandingPage() {
  const role = await getActiveRole();
  if (role) {
    redirect("/workspace");
  }

  return (
    <main className="shell">
      <div className="hero-grid">
        <section className="panel panel-dark">
          <div className="panel-inner stack">
            <p className="eyebrow">Superscriber</p>
            <h1 className="headline">One governed workspace for sensitive recordings.</h1>
            <p className="lede" style={{ color: "rgba(238, 246, 242, 0.8)" }}>
              Record or upload, transcribe with diarization, review in the browser,
              and approve server-side. The demo uses role cookies, local JSON
              persistence, and mock transcription adapters, but the workflow boundary
              is the same one the approved plan calls for.
            </p>
            <div className="button-row">
              <span className="pill" data-tone="info">
                Browser-bound review
              </span>
              <span className="pill" data-tone="ok">
                Raw media stays server-side
              </span>
              <span className="pill" data-tone="warn">
                Demo auth only
              </span>
            </div>
          </div>
        </section>

        <section className="panel panel-strong">
          <div className="panel-inner stack">
            <p className="eyebrow">Enter Demo Workspace</p>
            <h2 className="section-title">Choose the role you want to simulate.</h2>
            <div className="role-grid">
              {USER_ROLES.map((entry) => (
                <form key={entry} action={enterWorkspaceAction} className="role-card">
                  <span className="badge">{ROLE_COPY[entry].badge}</span>
                  <div className="stack-tight">
                    <h3 className="card-title">{ROLE_COPY[entry].title}</h3>
                    <p className="body-copy">{ROLE_COPY[entry].description}</p>
                  </div>
                  <input type="hidden" name="role" value={entry} />
                  <button className="button button-primary" type="submit">
                    Continue as {entry}
                  </button>
                </form>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
