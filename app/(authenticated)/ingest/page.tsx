import { redirect } from "next/navigation";
import { IngestPanel } from "@/components/ingest-panel";
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
          <h1 className="surface-intro__title">Capture or upload directly into the managed queue.</h1>
          <p className="surface-intro__description">
            This temporary wrapper keeps the current ingest component available while the new ingest experience lands in a later task.
          </p>
        </div>
      </section>
      <IngestPanel />
    </div>
  );
}
