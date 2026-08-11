"use client";

import {
  useRecordingProgress,
  ProgressAwareStatus,
  type RecordingProgressSample,
} from "./use-recording-progress";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { UserRole } from "@/domain/models";
import type { WorkInboxRow } from "@/server/work-inbox/service";
import { StatusBadge } from "@/components/ui/status-badge";

type LedgerColumn = {
  id: string;
  label: string;
};

function toneForStage(stage: WorkInboxRow["stage"]) {
  if (stage === "approved") {
    return "success" as const;
  }

  if (stage === "pending_approval" || stage === "verifying" || stage === "reopened") {
    return "warning" as const;
  }

  if (stage === "needs_ingest_attention" || stage === "changes_requested") {
    return "danger" as const;
  }

  return "info" as const;
}

function columnsForRole(role: UserRole): LedgerColumn[] {
  const shared: LedgerColumn[] = [
    { id: "recording", label: "Recording" },
    { id: "source", label: "Source" },
    { id: "revision", label: "Revision" },
    { id: "status", label: "Status" },
    { id: "updated", label: "Updated" },
    { id: "action", label: "Action" },
  ];

  if (role === "uploader") {
    return shared;
  }

  return [shared[0]!, shared[1]!, { id: "assignment", label: "Assignment" }, ...shared.slice(2)];
}

function useDesktopLedger() {
  const [desktop, setDesktop] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 960,
  );

  useEffect(() => {
    const onResize = () => {
      setDesktop(window.innerWidth >= 960);
    };

    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return desktop;
}

function AssignmentChip({ label }: { label: string }) {
  return (
    <span aria-label={`Assignment: ${label}`} className="work-chip">
      {label}
    </span>
  );
}

function UpdatedTime({ row }: { row: WorkInboxRow }) {
  return (
    <time className="recording-ledger__time" dateTime={row.updatedAtIso}>
      {row.updatedAtLabel}
      <span className="sr-only"> {row.updatedAtIso}</span>
    </time>
  );
}

function LedgerTable({
  role,
  rows,
  progressSamples,
}: {
  role: UserRole;
  rows: WorkInboxRow[];
  progressSamples: Record<string, RecordingProgressSample>;
}) {
  const columns = columnsForRole(role);

  return (
    <table aria-label="Work recordings" className="recording-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.id} scope="col">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.recordingId}-${row.updatedAtIso}`}>
            <th className="recording-ledger__recording" scope="row">
              <span className="recording-ledger__title">{row.title}</span>
              <span className="recording-ledger__meta">Recording {row.recordingId}</span>
              {role === "uploader" ? <AssignmentChip label={row.assignmentLabel} /> : null}
            </th>
            <td>{row.sourceLabel}</td>
            {role === "uploader" ? null : (
              <td>
                <AssignmentChip label={row.assignmentLabel} />
              </td>
            )}
            <td>{row.revisionLabel}</td>
            <td>
              {row.stage === "transcribing" ? (
                <ProgressAwareStatus
                  fallbackLabel={row.stageLabel}
                  sample={progressSamples[row.recordingId]}
                />
              ) : (
                <StatusBadge tone={toneForStage(row.stage)}>{row.stageLabel}</StatusBadge>
              )}
            </td>
            <td>
              <UpdatedTime row={row} />
            </td>
            <td>
              {row.actionLabel !== null ? (
                <Link
                  aria-label={row.title}
                  className="recording-action interactive-target"
                  href={row.href}
                >
                  {row.actionLabel}
                </Link>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LedgerList({
  role,
  rows,
  progressSamples,
}: {
  role: UserRole;
  rows: WorkInboxRow[];
  progressSamples: Record<string, RecordingProgressSample>;
}) {
  return (
    <ul aria-label="Work recordings" className="recording-list">
      {rows.map((row) => {
        const titleId = `recording-${row.recordingId}`;

        return (
          <li className="recording-list__item" key={`${row.recordingId}-${row.updatedAtIso}`}>
            <article aria-labelledby={titleId} className="recording-card">
              <header className="recording-card__header">
                <div className="recording-card__title-group">
                  <h3 className="recording-card__title" id={titleId}>
                    {row.title}
                  </h3>
                  <p className="recording-card__meta">Recording {row.recordingId}</p>
                </div>
                {row.stage === "transcribing" ? (
                  <ProgressAwareStatus
                    fallbackLabel={row.stageLabel}
                    sample={progressSamples[row.recordingId]}
                  />
                ) : (
                  <StatusBadge tone={toneForStage(row.stage)}>{row.stageLabel}</StatusBadge>
                )}
              </header>
              <dl className="recording-card__facts">
                <div>
                  <dt>Source</dt>
                  <dd>{row.sourceLabel}</dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>{row.revisionLabel}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{row.progressLabel}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>
                    <UpdatedTime row={row} />
                  </dd>
                </div>
                <div>
                  <dt>{role === "uploader" ? "Uploader" : "Assignment"}</dt>
                  <dd>
                    <AssignmentChip label={row.assignmentLabel} />
                  </dd>
                </div>
              </dl>
              {row.actionLabel !== null ? (
                <Link
                  aria-label={row.title}
                  className="recording-action interactive-target"
                  href={row.href}
                >
                  {row.actionLabel}
                </Link>
              ) : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export function RecordingLedger({ role, rows }: { role: UserRole; rows: WorkInboxRow[] }) {
  const desktop = useDesktopLedger();
  // Live transcription progress: one batched poll for every transcribing row
  // currently on screen.
  const progressSamples = useRecordingProgress(
    rows.filter((row) => row.stage === "transcribing").map((row) => row.recordingId),
  );

  return desktop ? (
    <LedgerTable progressSamples={progressSamples} role={role} rows={rows} />
  ) : (
    <LedgerList progressSamples={progressSamples} role={role} rows={rows} />
  );
}
