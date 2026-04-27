import Link from "next/link";
import { ingestRecordingAction } from "@/app/actions";
import { USER_ROLES, UserRole } from "@/domain/models";
import { IngestPanel } from "@/components/ingest-panel";
import { SessionBar } from "@/components/session-bar";
import {
  formatDateTime,
  formatRoleLabel,
  toneForBucket,
} from "@/lib/format";
import { listWorkspaceOverview } from "@/server/repository";
import { requireActiveRole } from "@/server/session";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const ROLE_HOME: Record<UserRole, { title: string; subtitle: string }> = {
  uploader: {
    title: "Governed ingest queue",
    subtitle:
      "Capture or upload sensitive recordings directly into the managed environment.",
  },
  reviewer: {
    title: "Browser review queue",
    subtitle:
      "Open draft transcripts, verify speaker turns, and correct text without local copies.",
  },
  approver: {
    title: "Approval control desk",
    subtitle:
      "Review pending revisions, approve the record, and govern export rights.",
  },
  admin: {
    title: "Institutional oversight workspace",
    subtitle:
      "Inspect all queues, validate the policy profile, and simulate support across roles.",
  },
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function countForRole(role: UserRole, buckets: ReturnType<typeof listWorkspaceOverview>["buckets"]) {
  if (role === "reviewer") {
    return buckets.find((bucket) => bucket.bucket === "needs_review")?.recordings.length ?? 0;
  }

  if (role === "approver") {
    return (
      buckets.find((bucket) => bucket.bucket === "pending_approval")?.recordings.length ?? 0
    );
  }

  return buckets.reduce((sum, bucket) => sum + bucket.recordings.length, 0);
}

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const role = await requireActiveRole();
  const params = await searchParams;
  const overview = listWorkspaceOverview(role);
  const notice = firstValue(params.notice);
  const error = firstValue(params.error);
  const primaryCount = countForRole(role, overview.buckets);
  const approvedCount =
    overview.buckets.find((bucket) => bucket.bucket === "approved")?.recordings.length ?? 0;
  const pendingCount =
    overview.buckets.find((bucket) => bucket.bucket === "pending_approval")?.recordings.length ?? 0;
  const transcribingCount =
    overview.buckets.find((bucket) => bucket.bucket === "transcribing")?.recordings.length ?? 0;
  const canIngest = role === "uploader" || role === "admin";

  return (
    <main className="shell shell-wide stack">
      <SessionBar activeRole={role} />

      <section className="panel panel-dark">
        <div className="panel-inner workspace-header">
          <div className="stack-tight">
            <p className="eyebrow">{overview.workspace.name}</p>
            <h1 className="workspace-title">{ROLE_HOME[role].title}</h1>
            <p className="lede" style={{ color: "rgba(238, 246, 242, 0.8)" }}>
              {ROLE_HOME[role].subtitle}
            </p>
          </div>

          <div className="kicker-row">
            <span className="pill" data-tone="info">
              Role: {formatRoleLabel(role)}
            </span>
            <span className="pill" data-tone="ok">
              Policy: {overview.workspace.policyProfileId}
            </span>
            <span className="pill" data-tone="warn">
              Demo auth cookie
            </span>
          </div>
        </div>
      </section>

      {notice ? (
        <div className="banner" data-tone="ok">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="banner" data-tone="danger">
          {error}
        </div>
      ) : null}

      <section className="metric-grid">
        <article className="metric-card">
          <p className="metric-value">{primaryCount}</p>
          <p className="metric-label">Role-relevant items</p>
        </article>
        <article className="metric-card">
          <p className="metric-value">{transcribingCount}</p>
          <p className="metric-label">Currently transcribing</p>
        </article>
        <article className="metric-card">
          <p className="metric-value">{pendingCount}</p>
          <p className="metric-label">Pending approval</p>
        </article>
        <article className="metric-card">
          <p className="metric-value">{approvedCount}</p>
          <p className="metric-label">Approved records</p>
        </article>
      </section>

      <section className="workspace-layout">
        <div className="stack">
          {canIngest ? (
            <IngestPanel action={ingestRecordingAction} />
          ) : (
            <section className="panel">
              <div className="panel-inner stack-tight">
                <p className="eyebrow">Ingest locked</p>
                <h2 className="section-title">This role cannot create new recordings.</h2>
                <p className="body-copy">
                  Switch to the uploader or admin role if you want to test the governed
                  capture and upload flow in this demo.
                </p>
              </div>
            </section>
          )}

          <section className="panel">
            <div className="panel-inner stack">
              <div className="stack-tight">
                <p className="eyebrow">Queue board</p>
                <h2 className="section-title">One workflow, six clear states.</h2>
              </div>
              <div className="queue-board">
                {overview.buckets.map((bucket) => (
                  <article
                    key={bucket.bucket}
                    className={`queue-card ${bucket.recordings.length === 0 ? "queue-card-empty" : ""}`}
                  >
                    <div className="status-row">
                      <span className="pill" data-tone={toneForBucket(bucket.bucket)}>
                        {bucket.label}
                      </span>
                      <span className="badge">{bucket.recordings.length} items</span>
                    </div>
                    <p className="body-copy">{bucket.description}</p>
                    <div className="recording-list">
                      {bucket.recordings.length === 0 ? (
                        <div className="recording-item recording-item-empty">
                          <p className="recording-item-title">No items in this state.</p>
                        </div>
                      ) : (
                        bucket.recordings.map((recording) => (
                          <Link
                            key={recording.id}
                            href={`/recordings/${recording.id}`}
                            className="recording-item"
                          >
                            <div className="status-row">
                              <p className="recording-item-title">{recording.title}</p>
                              <span className="badge">{recording.mediaKind}</span>
                            </div>
                            <div className="recording-item-meta">
                              <span>{recording.source}</span>
                              <span>{recording.languageHint}</span>
                              <span>{formatDateTime(recording.updatedAt)}</span>
                            </div>
                            {recording.verificationSummary ? (
                              <p className="body-copy">{recording.verificationSummary}</p>
                            ) : null}
                          </Link>
                        ))
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-inner stack">
              <div className="stack-tight">
                <p className="eyebrow">Policy profile</p>
                <h2 className="section-title">Server-side rules for this workspace.</h2>
                <p className="body-copy">{overview.policySummary}</p>
              </div>

              <div className="policy-grid">
                <div className="policy-row">
                  <span>Raw media download</span>
                  <strong>Blocked</strong>
                </div>
                <div className="policy-row">
                  <span>Media playback</span>
                  <strong>{overview.policyDecision.canViewMedia ? "Allowed" : "Denied"}</strong>
                </div>
                <div className="policy-row">
                  <span>Draft editing</span>
                  <strong>{overview.policyDecision.canEditDraft ? "Allowed" : "Denied"}</strong>
                </div>
                <div className="policy-row">
                  <span>Submit for approval</span>
                  <strong>
                    {overview.policyDecision.canSubmitForApproval ? "Allowed" : "Denied"}
                  </strong>
                </div>
                <div className="policy-row">
                  <span>Approve transcript</span>
                  <strong>{overview.policyDecision.canApprove ? "Allowed" : "Denied"}</strong>
                </div>
                <div className="policy-row">
                  <span>Approved export</span>
                  <strong>
                    {overview.policyDecision.canDownloadApprovedTranscript
                      ? "Policy-gated"
                      : "Denied"}
                  </strong>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-inner stack-tight">
              <p className="eyebrow">Demo notes</p>
              <h2 className="section-title">What this slice implements now.</h2>
              <div className="stack-tight">
                <p className="body-copy">
                  The workspace persists to local JSON files on the server, not to browser
                  storage. Upload and recording both enter the same governed ingestion flow.
                </p>
                <p className="body-copy">
                  Verification and transcription are mocked today, but they now run behind
                  a canonical orchestration service with explicit ingestion-session and
                  transcript-job state.
                </p>
                <p className="body-copy">
                  Use the role switcher above to test the different home screens and
                  action permissions across uploader, reviewer, approver, and admin.
                </p>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
