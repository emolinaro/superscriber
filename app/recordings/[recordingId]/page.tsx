import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  approveRevisionAction,
  reopenRevisionAction,
  saveDraftAction,
  submitRevisionAction,
} from "@/app/actions";
import { canAccessRecording } from "@/server/access/service";
import { OrchestrationStatusPoller } from "@/components/orchestration-status-poller";
import { ReviewWorkspace } from "@/components/review-workspace";
import { SessionBar } from "@/components/session-bar";
import {
  formatDateTime,
  formatRoleLabel,
  formatSegmentWindow,
  toneForApprovalState,
  toneForIntegrityState,
  toneForJobState,
} from "@/lib/format";
import { getRecordingDetail } from "@/server/repository";
import { requireActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Params = Promise<{ recordingId: string }>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatPercent(value: number | null) {
  return value === null ? "n/a" : `${Math.round(value)}%`;
}

export default async function RecordingPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const principal = await requireActivePrincipal();
  const role = principal.role;
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;
  const access = canAccessRecording(principal, resolvedParams.recordingId);
  if (!access.allowed) {
    redirect(`/workspace?error=${encodeURIComponent(access.reason ?? "This recording is not assigned to your account.")}`);
  }
  const detail = getRecordingDetail(resolvedParams.recordingId, role);

  if (!detail) {
    notFound();
  }

  const notice = firstValue(resolvedSearchParams.notice);
  const error = firstValue(resolvedSearchParams.error);
  const mediaUrl =
    detail.policyDecision.canViewMedia && detail.recording.mediaPath
      ? `/api/media/${detail.recording.id}`
      : null;
  const approvedTranscriptExportBaseUrl =
    detail.policyDecision.canDownloadApprovedTranscript &&
    detail.recording.approvedRevisionId
      ? `/api/recordings/${detail.recording.id}/transcript`
      : null;
  const approvalState = detail.recording.approvedRevisionId
    ? "approved"
    : detail.recording.pendingRevisionId
      ? "pending"
      : "not_submitted";

  return (
    <main className="shell shell-wide stack review-page-shell">
      <SessionBar principal={principal} />

      <section className="review-hero">
        <div className="review-hero-top">
          <div className="status-row">
            <Link href="/workspace" className="button button-dark">
              Back to workspace
            </Link>
            <span className="pill" data-tone="info">
              Active role: {formatRoleLabel(role)}
            </span>
          </div>
          <div className="kicker-row">
            <span className="pill" data-tone={toneForIntegrityState(detail.recording.integrityState)}>
              Integrity: {detail.recording.integrityState}
            </span>
            <span className="pill" data-tone={toneForJobState(detail.recording.transcriptJobState)}>
              Transcript: {detail.recording.transcriptJobState}
            </span>
            <span className="pill" data-tone={toneForApprovalState(approvalState)}>
              Approval: {approvalState.replace("_", " ")}
            </span>
          </div>
        </div>

        <div className="review-hero-copy">
          <p className="review-hero-brand">{detail.workspace.name}</p>
          <h1 className="review-hero-title">{detail.recording.title}</h1>
          <p className="review-hero-lede">{detail.policySummary}</p>
        </div>
      </section>

      <section className="review-summary-grid">
        <article className="review-summary-card">
          <p className="eyebrow">Source</p>
          <h2 className="review-summary-value">{detail.recording.source}</h2>
          <p className="body-copy">{detail.recording.verificationSummary}</p>
        </article>
        <article className="review-summary-card">
          <p className="eyebrow">Language</p>
          <h2 className="review-summary-value">{detail.recording.languageHint}</h2>
          <p className="body-copy">
            Uploaded by {formatRoleLabel(detail.recording.uploadedByRole)}
          </p>
        </article>
        <article className="review-summary-card">
          <p className="eyebrow">Revision</p>
          <h2 className="review-summary-value">
            {detail.currentRevision ? `v${detail.currentRevision.version}` : "Not ready"}
          </h2>
          <p className="body-copy">Updated {formatDateTime(detail.recording.updatedAt)}</p>
        </article>
        <article className="review-summary-card">
          <p className="eyebrow">Job</p>
          <h2 className="review-summary-value">
            {detail.transcriptJob?.state ?? detail.recording.transcriptJobState}
          </h2>
          <p className="body-copy">
            {detail.transcriptJob
              ? `${formatPercent(detail.transcriptJob.progressPercent)} complete`
              : "No transcript job registered."}
          </p>
        </article>
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

      <OrchestrationStatusPoller
        recordingId={detail.recording.id}
        integrityState={detail.recording.integrityState}
        transcriptJobState={detail.recording.transcriptJobState}
        currentRevisionId={detail.recording.currentRevisionId}
      />

      <section className="review-layout review-layout-annotation">
        <div className="stack">
          <section className="panel review-main-panel">
            <div className="panel-inner stack">
              <ReviewWorkspace
                recording={detail.recording}
                currentRevision={detail.currentRevision}
                policyDecision={detail.policyDecision}
                mediaUrl={mediaUrl}
                approvedTranscriptExportBaseUrl={approvedTranscriptExportBaseUrl}
                saveAction={saveDraftAction}
                submitAction={submitRevisionAction}
                approveAction={approveRevisionAction}
                reopenAction={reopenRevisionAction}
              />
            </div>
          </section>
        </div>

        <aside className="stack">
          <section className="panel review-side-panel" id="review-governance">
            <div className="panel-inner stack">
              <div className="stack-tight">
                <p className="eyebrow">Governance</p>
                <h2 className="section-title">Policy and engine status.</h2>
                <p className="body-copy">
                  Keep institutional rules visible without turning the workspace into
                  an infrastructure console.
                </p>
              </div>
              <div className="transcript-grid">
                <article className="history-card">
                  <div className="status-row">
                    <strong>Playback policy</strong>
                    <span className="badge">
                      {detail.policyDecision.canViewMedia ? "Allowed" : "Denied"}
                    </span>
                  </div>
                  <p className="body-copy">
                    Raw media remains server-side. Reviewers can listen in the browser
                    only when the active role and workspace policy allow it.
                  </p>
                  <p className="field-note">
                    Approved export{" "}
                    {detail.policyDecision.canDownloadApprovedTranscript
                      ? "is policy-gated."
                      : "is blocked."}
                  </p>
                </article>
                <article className="history-card">
                  <div className="status-row">
                    <strong>Ingestion session</strong>
                    <span className="badge">
                      {detail.ingestionSession?.state ?? detail.recording.integrityState}
                    </span>
                  </div>
                  <p className="body-copy">
                    {detail.ingestionSession?.verificationSummary ??
                      detail.recording.verificationSummary}
                  </p>
                  <p className="field-note">
                    Adapter {detail.ingestionSession?.adapter ?? "legacy-import"}
                  </p>
                  <p className="field-note">
                    Updated{" "}
                    {formatDateTime(
                      detail.ingestionSession?.updatedAt ?? detail.recording.updatedAt,
                    )}
                  </p>
                </article>
                <article className="history-card">
                  <div className="status-row">
                    <strong>Transcript job</strong>
                    <span className="badge">
                      {detail.transcriptJob?.state ?? detail.recording.transcriptJobState}
                    </span>
                  </div>
                  <p className="body-copy">
                    Progress {formatPercent(detail.transcriptJob?.progressPercent ?? null)}
                    {detail.transcriptJob?.etaSeconds !== null &&
                    detail.transcriptJob?.etaSeconds !== undefined
                      ? ` · ETA ${detail.transcriptJob.etaSeconds}s`
                      : ""}
                  </p>
                  <p className="field-note">
                    Diarization {detail.transcriptJob?.diarizationStatus ?? "pending"}
                  </p>
                  <p className="field-note">
                    Adapter {detail.transcriptJob?.adapter ?? "legacy-import"}
                  </p>
                </article>
              </div>
            </div>
          </section>

          <section className="panel review-side-panel" id="review-history">
            <div className="panel-inner stack">
              <div className="stack-tight">
                <p className="eyebrow">Revision history</p>
                <h2 className="section-title">Recorded transcript states.</h2>
              </div>
              <div className="transcript-grid">
                {detail.revisions.length === 0 ? (
                  <p className="body-copy">No transcript revisions exist yet.</p>
                ) : (
                  detail.revisions.map((revision) => (
                    <article key={revision.id} className="history-card">
                      <div className="status-row">
                        <strong>v{revision.version}</strong>
                        <span className="badge">{revision.state}</span>
                      </div>
                      <p className="body-copy">{revision.summary}</p>
                      {revision.segments[0] ? (
                        <p className="field-note">
                          First segment {formatSegmentWindow(revision.segments[0].startMs, revision.segments[0].endMs)}
                        </p>
                      ) : null}
                      <p className="field-note">Created {formatDateTime(revision.createdAt)}</p>
                    </article>
                  ))
                )}
              </div>
            </div>
          </section>

          <section className="panel review-side-panel" id="review-audit">
            <div className="panel-inner stack">
              <div className="stack-tight">
                <p className="eyebrow">Audit log</p>
                <h2 className="section-title">Recent governed events.</h2>
              </div>
              <ul className="audit-list">
                {detail.auditEvents.map((event) => (
                  <li key={event.id} className="audit-item">
                    <strong>{event.type}</strong>
                    <span className="body-copy">{event.detail}</span>
                    <span className="field-note">
                      {formatRoleLabel(event.actorRole)} · {formatDateTime(event.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
