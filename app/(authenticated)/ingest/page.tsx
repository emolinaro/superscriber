import { redirect } from "next/navigation";
import { IngestFlow } from "@/components/ingest/ingest-flow";
import { requireActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function IngestPage() {
  const principal = await requireActivePrincipal("/ingest");

  if (principal.role !== "uploader" && principal.role !== "admin") {
    redirect(
      `/workspace?error=${encodeURIComponent("Only uploader and admin accounts can open ingest.")}`,
    );
  }

  return (
    <div className="shell shell-wide stack ingest-shell">
      <section className="surface-intro surface-intro--ingest">
        <div className="surface-intro__copy">
          <p className="surface-intro__eyebrow">Governed ingest</p>
          <h1 className="surface-intro__title">Bring audio into the governed queue without losing your place.</h1>
          <p className="surface-intro__description">
            Choose a source, add the required details, and let the browser resume from the
            last committed byte when a transfer is interrupted.
          </p>
        </div>
      </section>
      <IngestFlow principalRole={principal.role} />
    </div>
  );
}
