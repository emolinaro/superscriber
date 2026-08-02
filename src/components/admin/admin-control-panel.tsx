import {
  assignRecordingFormAction as assignRecordingAction,
  createUserFormAction as createUserAction,
  unassignRecordingFormAction as unassignRecordingAction,
} from "@/server/actions/administration-actions";
import { formatDateTime, formatRoleLabel } from "@/lib/format";
import type { AccountDirectoryEntry, AssignmentSummary } from "@/server/access/service";

type RecordingOption = {
  id: string;
  title: string;
};

export function AdminControlPanel({
  users,
  assignableUsers,
  recordings,
  assignments,
}: {
  users: AccountDirectoryEntry[];
  assignableUsers: AccountDirectoryEntry[];
  recordings: RecordingOption[];
  assignments: Array<AssignmentSummary & { recordingTitle: string }>;
}) {
  return (
    <section className="panel">
      <div className="panel-inner stack">
        <div className="stack-tight">
          <p className="eyebrow">Institutional accounts</p>
          <h2 className="section-title">Create local users and assign governed work.</h2>
          <p className="body-copy">
            Reviewer and approver access now depends on explicit assignments rather
            than a role-wide demo queue.
          </p>
        </div>

        <form action={createUserAction} className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="account-display-name">
              Name
            </label>
            <input id="account-display-name" name="displayName" required type="text" />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="account-email">
              Email
            </label>
            <input id="account-email" name="email" required type="email" />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="account-password">
              Password
            </label>
            <input id="account-password" name="password" required type="password" />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="account-role">
              Role
            </label>
            <select defaultValue="reviewer" id="account-role" name="role" required>
              <option value="uploader">Uploader</option>
              <option value="reviewer">Reviewer</option>
              <option value="approver">Approver</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          <button className="button button-primary" type="submit">
            Create local account
          </button>
        </form>

        <div className="stack-tight">
          <h3 className="card-title">Current accounts</h3>
          {users.length === 0 ? (
            <p className="body-copy">No local accounts exist yet.</p>
          ) : (
            <div className="admin-list">
              {users.map((user) => (
                <article key={user.id} className="history-card">
                  <div className="status-row">
                    <strong>{user.displayName}</strong>
                    <span className="badge">{formatRoleLabel(user.role)}</span>
                  </div>
                  <p className="body-copy">{user.email}</p>
                  <p className="field-note">
                    {user.activeAssignmentCount} active assignment
                    {user.activeAssignmentCount === 1 ? "" : "s"} · created{" "}
                    {formatDateTime(user.createdAt)}
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="stack-tight">
          <h3 className="card-title">Assign recordings</h3>
          {assignableUsers.length === 0 ? (
            <p className="body-copy">
              Create a reviewer or approver account before assigning recordings.
            </p>
          ) : recordings.length === 0 ? (
            <p className="body-copy">No recordings exist yet to assign.</p>
          ) : (
            <form action={assignRecordingAction} className="form-grid">
              <div className="field">
                <label className="field-label" htmlFor="assignment-recording">
                  Recording
                </label>
                <select id="assignment-recording" name="recordingId" required>
                  {recordings.map((recording) => (
                    <option key={recording.id} value={recording.id}>
                      {recording.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="assignment-user">
                  Assigned user
                </label>
                <select id="assignment-user" name="userId" required>
                  {assignableUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.displayName} · {formatRoleLabel(user.role)}
                    </option>
                  ))}
                </select>
              </div>

              <button className="button button-secondary" type="submit">
                Assign recording
              </button>
            </form>
          )}
        </div>

        <div className="stack-tight">
          <h3 className="card-title">Active assignments</h3>
          {assignments.length === 0 ? (
            <p className="body-copy">
              Reviewer and approver desks stay empty until recordings are assigned.
            </p>
          ) : (
            <div className="admin-list">
              {assignments.map((assignment) => (
                <article key={assignment.id} className="history-card">
                  <div className="status-row">
                    <strong>{assignment.recordingTitle}</strong>
                    <span className="badge">{formatRoleLabel(assignment.userRole)}</span>
                  </div>
                  <p className="body-copy">
                    Assigned to {assignment.userDisplayName} · {assignment.userEmail}
                  </p>
                  <div className="status-row">
                    <p className="field-note">Updated {formatDateTime(assignment.updatedAt)}</p>
                    <form action={unassignRecordingAction}>
                      <input name="assignmentId" type="hidden" value={assignment.id} />
                      <button className="button button-quiet" type="submit">
                        Remove
                      </button>
                    </form>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
