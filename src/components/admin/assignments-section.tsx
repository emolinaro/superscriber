"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import type { CommandResult } from "@/lib/command-result";
import type { AdministrationAssignmentsViewModel } from "@/server/administration/service";
import {
  assignRecordingAction as defaultAssignRecordingAction,
  removeRecordingAssignmentAction as defaultRemoveRecordingAssignmentAction,
  type AdministrationMutationResult,
  type AssignRecordingInput,
  type RemoveRecordingAssignmentInput,
} from "@/server/actions/administration-actions";

function filtersToSearch(
  model: AdministrationAssignmentsViewModel,
  status: "active" | "history",
) {
  const search = new URLSearchParams();
  search.set("section", "assignments");
  search.set("status", status);

  if (model.filters.recordingId) {
    search.set("recordingId", model.filters.recordingId);
  }
  if (model.filters.userId) {
    search.set("userId", model.filters.userId);
  }
  if (model.filters.role) {
    search.set("role", model.filters.role);
  }
  if (model.filters.from) {
    search.set("from", model.filters.from);
  }
  if (model.filters.to) {
    search.set("to", model.filters.to);
  }

  return `/administration?${search.toString()}`;
}

export function AssignmentsSection({
  model,
  phoneSafetyMode,
  assignRecordingAction = defaultAssignRecordingAction,
  removeRecordingAssignmentAction = defaultRemoveRecordingAssignmentAction,
}: {
  model: AdministrationAssignmentsViewModel;
  phoneSafetyMode: boolean;
  assignRecordingAction?: (
    input: AssignRecordingInput,
  ) => Promise<CommandResult<AdministrationMutationResult>>;
  removeRecordingAssignmentAction?: (
    input: RemoveRecordingAssignmentInput,
  ) => Promise<CommandResult<AdministrationMutationResult>>;
}) {
  const router = useRouter();
  const [assignOpen, setAssignOpen] = useState(false);
  const [removeAssignmentId, setRemoveAssignmentId] = useState<string | null>(null);
  const [recordingSearch, setRecordingSearch] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [selectedRecordingId, setSelectedRecordingId] = useState(model.recordings[0]?.recordingId ?? "");
  const [selectedUserId, setSelectedUserId] = useState(model.assignableUsers[0]?.id ?? "");
  const [assignPending, setAssignPending] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const visibleRecordings = useMemo(() => {
    const needle = recordingSearch.trim().toLowerCase();
    return model.recordings.filter((recording) =>
      !needle ? true : recording.title.toLowerCase().includes(needle),
    );
  }, [model.recordings, recordingSearch]);

  const visibleUsers = useMemo(() => {
    const needle = userSearch.trim().toLowerCase();
    return model.assignableUsers.filter((user) =>
      !needle
        ? true
        : user.displayName.toLowerCase().includes(needle) || user.role.toLowerCase().includes(needle),
    );
  }, [model.assignableUsers, userSearch]);

  useEffect(() => {
    if (!visibleRecordings.some((recording) => recording.recordingId === selectedRecordingId)) {
      setSelectedRecordingId(visibleRecordings[0]?.recordingId ?? "");
    }
  }, [selectedRecordingId, visibleRecordings]);

  useEffect(() => {
    if (!visibleUsers.some((user) => user.id === selectedUserId)) {
      setSelectedUserId(visibleUsers[0]?.id ?? "");
    }
  }, [selectedUserId, visibleUsers]);

  useEffect(() => {
    if (!phoneSafetyMode) {
      return;
    }

    setAssignOpen(false);
    setRemoveAssignmentId(null);
  }, [phoneSafetyMode]);

  const selectedRecording = model.recordings.find(
    (recording) => recording.recordingId === selectedRecordingId,
  );
  const selectedUser = model.assignableUsers.find((user) => user.id === selectedUserId);
  const compatibility =
    selectedRecording && selectedUser
      ? selectedRecording.compatibility[selectedUser.role]
      : null;
  const removeAssignment = model.assignments.find(
    (assignment) => assignment.id === removeAssignmentId,
  ) ?? null;

  async function submitAssignment() {
    if (
      assignPending ||
      !selectedRecordingId ||
      !selectedUserId ||
      !compatibility ||
      !compatibility.allowed
    ) {
      return;
    }

    setAssignPending(true);
    setAssignError(null);
    setNotice(null);

    try {
      const result = await assignRecordingAction({
        recordingId: selectedRecordingId,
        userId: selectedUserId,
      });
      if (!result.ok) {
        setAssignError(result.message);
        return;
      }

      setAssignOpen(false);
      setNotice(result.notice ?? null);
      router.refresh();
    } finally {
      setAssignPending(false);
    }
  }

  async function confirmRemoval() {
    if (!removeAssignment || removePending) {
      return;
    }

    setRemovePending(true);
    setRemoveError(null);
    setNotice(null);

    try {
      const result = await removeRecordingAssignmentAction({
        assignmentId: removeAssignment.id,
      });
      if (!result.ok) {
        setRemoveError(result.message);
        return;
      }

      setRemoveAssignmentId(null);
      setNotice(result.notice ?? null);
      router.refresh();
      window.requestAnimationFrame(() => {
        document.getElementById("assignments-heading")?.focus();
      });
    } finally {
      setRemovePending(false);
    }
  }

  const historyMode = model.filters.status === "history";

  return (
    <section className="panel panel-strong administration-section stack" aria-labelledby="assignments-heading">
      <div className="panel-inner stack administration-section__body">
        <div className="administration-section__header">
          <div className="stack-tight">
            <p className="eyebrow">Assignments</p>
            <h2 className="section-title" id="assignments-heading" tabIndex={-1}>
              Assignments
            </h2>
            <p className="body-copy">
              Review active access grants and retained assignment history in explicit UTC.
            </p>
          </div>
          {!phoneSafetyMode && !historyMode ? (
            <button
              className="button button-primary interactive-target"
              onClick={() => {
                setAssignOpen(true);
                setAssignError(null);
              }}
              type="button"
            >
              Assign work
            </button>
          ) : null}
        </div>

        {notice ? (
          <p aria-live="polite" className="administration-status" role="status">
            {notice}
          </p>
        ) : null}

        <div className="administration-subnav" role="navigation" aria-label="Assignment ledgers">
          <a
            aria-current={!historyMode ? "page" : undefined}
            className="administration-subnav__link interactive-target"
            href={filtersToSearch(model, "active")}
          >
            Active
          </a>
          <a
            aria-current={historyMode ? "page" : undefined}
            className="administration-subnav__link interactive-target"
            href={filtersToSearch(model, "history")}
          >
            History
          </a>
        </div>

        <form action="/administration" className="administration-filters" method="get">
          <input name="section" type="hidden" value="assignments" />
          <input name="status" type="hidden" value={model.filters.status} />

          <label className="field" htmlFor="assignments-recording-filter">
            <span className="field-label">Recording</span>
            <select defaultValue={model.filters.recordingId ?? ""} id="assignments-recording-filter" name="recordingId">
              <option value="">All recordings</option>
              {model.recordings.map((recording) => (
                <option key={recording.recordingId} value={recording.recordingId}>
                  {recording.title}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor="assignments-user-filter">
            <span className="field-label">Assigned user</span>
            <select defaultValue={model.filters.userId ?? ""} id="assignments-user-filter" name="userId">
              <option value="">All assigned users</option>
              {model.assignableUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor="assignments-role-filter">
            <span className="field-label">Role</span>
            <select defaultValue={model.filters.role ?? ""} id="assignments-role-filter" name="role">
              <option value="">Any role</option>
              <option value="reviewer">Reviewer</option>
              <option value="approver">Approver</option>
            </select>
          </label>

          <label className="field" htmlFor="assignments-from-filter">
            <span className="field-label">Updated from (UTC)</span>
            <input defaultValue={model.filters.from ?? ""} id="assignments-from-filter" name="from" type="text" />
          </label>

          <label className="field" htmlFor="assignments-to-filter">
            <span className="field-label">Updated to (UTC)</span>
            <input defaultValue={model.filters.to ?? ""} id="assignments-to-filter" name="to" type="text" />
          </label>

          <button className="button button-secondary interactive-target" type="submit">
            Apply filters
          </button>
        </form>

        <div className="administration-table-wrap">
          <table className="administration-table">
            <thead>
              <tr>
                {model.columns.map((column) => (
                  <th key={column.id} scope="col">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.assignments.map((assignment) => (
                <tr key={assignment.id}>
                  <th scope="row">
                    <a className="administration-row-link" href={assignment.href}>
                      {assignment.recordingTitle}
                    </a>
                  </th>
                  {historyMode ? (
                    <>
                      <td>{assignment.userDisplayName}</td>
                      <td>{assignment.roleLabel}</td>
                      <td>{assignment.outcomeLabel ?? "-"}</td>
                      <td>{assignment.completedRevisionLabel ?? "-"}</td>
                      <td>
                        <time dateTime={assignment.updatedAtIso}>{assignment.updatedAtLabel}</time>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{assignment.stageLabel}</td>
                      <td>{assignment.userDisplayName}</td>
                      <td>{assignment.roleLabel}</td>
                      <td>
                        <time dateTime={assignment.updatedAtIso}>{assignment.updatedAtLabel}</time>
                      </td>
                      <td>
                        {!phoneSafetyMode ? (
                          <button
                            className="button button-quiet interactive-target"
                            onClick={() => {
                              setRemoveAssignmentId(assignment.id);
                              setRemoveError(null);
                            }}
                            type="button"
                          >
                            Remove assignment
                          </button>
                        ) : null}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="administration-card-list">
          {model.assignments.map((assignment) => (
            <li className="administration-card-list__item" key={assignment.id}>
              <article className="administration-card stack-tight">
                <h3 className="card-title">{assignment.recordingTitle}</h3>
                <dl className="administration-fact-list">
                  {!historyMode ? (
                    <>
                      <div>
                        <dt>Stage</dt>
                        <dd>{assignment.stageLabel}</dd>
                      </div>
                      <div>
                        <dt>Assignee</dt>
                        <dd>{assignment.userDisplayName}</dd>
                      </div>
                      <div>
                        <dt>Role</dt>
                        <dd>{assignment.roleLabel}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>
                          <time dateTime={assignment.updatedAtIso}>{assignment.updatedAtLabel}</time>
                        </dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>Assignee</dt>
                        <dd>{assignment.userDisplayName}</dd>
                      </div>
                      <div>
                        <dt>Role</dt>
                        <dd>{assignment.roleLabel}</dd>
                      </div>
                      <div>
                        <dt>Outcome</dt>
                        <dd>{assignment.outcomeLabel ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>Completed revision</dt>
                        <dd>{assignment.completedRevisionLabel ?? "-"}</dd>
                      </div>
                      <div>
                        <dt>Updated</dt>
                        <dd>
                          <time dateTime={assignment.updatedAtIso}>{assignment.updatedAtLabel}</time>
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
                {!historyMode && !phoneSafetyMode ? (
                  <button
                    className="button button-quiet interactive-target"
                    onClick={() => {
                      setRemoveAssignmentId(assignment.id);
                      setRemoveError(null);
                    }}
                    type="button"
                  >
                    Remove assignment
                  </button>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      </div>

      <Modal
        backdropClassName="administration-drawer-backdrop"
        onClose={() => {
          if (!assignPending) {
            setAssignOpen(false);
          }
        }}
        open={assignOpen && !phoneSafetyMode && !historyMode}
        surfaceClassName="administration-drawer"
        title="Assign governed work"
      >
        <div className="field">
          <label className="field-label" htmlFor="assignment-recording-search">
            Recording search
          </label>
          <input
            id="assignment-recording-search"
            onChange={(event) => setRecordingSearch(event.target.value)}
            role="searchbox"
            type="search"
            value={recordingSearch}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="assignment-recording">
            Recording
          </label>
          <select
            id="assignment-recording"
            onChange={(event) => setSelectedRecordingId(event.target.value)}
            value={selectedRecordingId}
          >
            {visibleRecordings.map((recording) => (
              <option key={recording.recordingId} value={recording.recordingId}>
                {recording.title}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="assignment-user-search">
            Assigned user search
          </label>
          <input
            id="assignment-user-search"
            onChange={(event) => setUserSearch(event.target.value)}
            role="searchbox"
            type="search"
            value={userSearch}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="assignment-user">
            Assigned user
          </label>
          <select id="assignment-user" onChange={(event) => setSelectedUserId(event.target.value)} value={selectedUserId}>
            {visibleUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.displayName} - {user.role === "reviewer" ? "Reviewer" : "Approver"}
              </option>
            ))}
          </select>
        </div>

        {compatibility ? (
          compatibility.allowed ? (
            <p className="field-note">Current state: {compatibility.label}</p>
          ) : (
            <p className="field-error-message">{compatibility.reason}</p>
          )
        ) : null}

        {assignError ? (
          <p className="field-error-message" role="alert">
            {assignError}
          </p>
        ) : null}

        <div className="button-row">
          <button className="button button-secondary" disabled={assignPending} onClick={() => setAssignOpen(false)} type="button">
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={assignPending || !compatibility?.allowed}
            onClick={() => void submitAssignment()}
            type="button"
          >
            {assignPending ? "Assigning recording..." : "Assign recording"}
          </button>
        </div>
      </Modal>

      <Modal
        onClose={() => {
          if (!removePending) {
            setRemoveAssignmentId(null);
          }
        }}
        open={Boolean(removeAssignment) && !phoneSafetyMode}
        title="Remove assignment"
      >
        {removeAssignment ? (
          <>
            <p>Recording: {removeAssignment.recordingTitle}</p>
            <p>Assigned user: {removeAssignment.userDisplayName}</p>
            <p>
              Removing this assignment revokes access immediately and keeps the assignment history.
            </p>
          </>
        ) : null}

        {removeError ? (
          <p className="field-error-message" role="alert">
            {removeError}
          </p>
        ) : null}

        <div className="button-row">
          <button className="button button-secondary" disabled={removePending} onClick={() => setRemoveAssignmentId(null)} type="button">
            Cancel
          </button>
          <button className="button button-primary" disabled={removePending} onClick={() => void confirmRemoval()} type="button">
            {removePending ? "Removing assignment..." : "Remove assignment"}
          </button>
        </div>
      </Modal>
    </section>
  );
}
