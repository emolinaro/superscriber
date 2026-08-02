import { redirect } from "next/navigation";
import { AdminControlPanel } from "@/components/admin/admin-control-panel";
import { listAssignableUsers, listLocalUsers } from "@/server/access/service";
import { listWorkspaceOverview } from "@/server/repository";
import { requireActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AdministrationPage() {
  const principal = await requireActivePrincipal();

  if (principal.role !== "admin") {
    redirect(
      `/workspace?error=${encodeURIComponent("Only admin accounts can open administration.")}`,
    );
  }

  const overview = listWorkspaceOverview(principal);
  const users = listLocalUsers();
  const assignableUsers = listAssignableUsers();
  const assignments = overview.visibleRecordings.flatMap((recording) =>
    (overview.assignmentsByRecordingId.get(recording.id) ?? []).map((assignment) => ({
      ...assignment,
      recordingTitle: recording.title,
    })),
  );

  return (
    <div className="shell shell-wide stack administration-shell">
      <section className="surface-intro surface-intro--administration">
        <div className="surface-intro__copy">
          <p className="surface-intro__eyebrow">Administration</p>
          <h1 className="surface-intro__title">Manage governed accounts and assignments.</h1>
          <p className="surface-intro__description">
            This temporary wrapper keeps the current administration component reachable until the dedicated redesign replaces it.
          </p>
        </div>
      </section>
      <AdminControlPanel
        assignments={assignments}
        assignableUsers={assignableUsers}
        recordings={overview.visibleRecordings.map((recording) => ({
          id: recording.id,
          title: recording.title,
        }))}
        users={users}
      />
    </div>
  );
}
