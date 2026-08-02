"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SaveDraftCommandInput, SubmitRevisionCommandInput } from "@/server/casefile/commands";
import type { CasefileMutationResult } from "@/server/actions/casefile-actions";
import type { CasefileViewModel } from "@/server/casefile/read-model";
import type { CasefileConflictSnapshot } from "@/server/casefile/errors";
import type { CommandResult } from "@/lib/command-result";
import { OrchestrationStatusPoller } from "@/components/orchestration-status-poller";
import { SessionRecoveryDialog } from "@/components/auth/session-recovery-dialog";
import { usePhoneSafetyMode } from "@/components/ui/phone-safety";
import { CaseHeader } from "./case-header";
import { ConflictPanel } from "./conflict-panel";
import { GovernanceDrawer } from "./governance-drawer";
import { MediaTransport } from "./media-transport";
import { StateActionBar } from "./state-action-bar";
import { TranscriptDocument } from "./transcript-document";

type SaveAction = (
  input: SaveDraftCommandInput,
) => Promise<CommandResult<CasefileMutationResult>>;

type SubmitAction = (
  input: SubmitRevisionCommandInput,
) => Promise<CommandResult<CasefileMutationResult>>;

function copySegments(casefile: CasefileViewModel) {
  return casefile.revision?.segments?.map((segment) => ({ ...segment })) ?? [];
}

function latestHref(casefile: CasefileViewModel, conflict?: CasefileConflictSnapshot | null) {
  const url = new URL(`/recordings/${casefile.recordingId}`, window.location.origin);
  const revisionId = conflict?.currentRevisionId ?? casefile.revision?.id ?? null;

  if (revisionId) {
    url.searchParams.set("revision", revisionId);
  }
  if (casefile.actionMode?.id) {
    url.searchParams.set("actionMode", casefile.actionMode.id);
  }

  return `${url.pathname}${url.search}`;
}

function isNavigableAnchor(target: EventTarget | null) {
  return target instanceof HTMLElement ? target.closest("a[href]") : null;
}

function shouldRefreshCasefile(current: CasefileViewModel, next: CasefileViewModel) {
  return current.updatedAt !== next.updatedAt || current.revision?.id !== next.revision?.id;
}

function UploaderStatusCasefile({ casefile }: { casefile: CasefileViewModel }) {
  return (
    <section className="casefile-status-only" aria-label="Recording status">
      <CaseHeader casefile={casefile} />
      <div className="casefile-status-only__grid">
        <article className="panel panel-strong">
          <div className="panel-inner stack-tight">
            <h2 className="section-title">Processing progress</h2>
            <p className="body-copy">
              {casefile.processing.progressPercent === null
                ? casefile.stageLabel
                : `${Math.round(casefile.processing.progressPercent)}% complete`}
            </p>
            <p className="field-note">{casefile.processing.verificationSummary ?? "Status available."}</p>
            {casefile.processing.recoveryHint ? (
              <p className="field-note">{casefile.processing.recoveryHint}</p>
            ) : null}
          </div>
        </article>
        <article className="panel panel-strong">
          <div className="panel-inner stack-tight">
            <h2 className="section-title">Safe metadata</h2>
            <p className="body-copy">Source: {casefile.sourceLabel}</p>
            <p className="body-copy">Language: {casefile.provenance.languageHint}</p>
            <p className="field-note">Updated {casefile.updatedAtLabel}</p>
          </div>
        </article>
      </div>
    </section>
  );
}

export function CasefileWorkspace({
  initialCasefile,
  saveAction,
  submitAction,
}: {
  initialCasefile: CasefileViewModel;
  saveAction: SaveAction;
  submitAction: SubmitAction;
}) {
  const phoneSafetyMode = usePhoneSafetyMode();
  const [casefile, setCasefile] = useState(initialCasefile);
  const [summary, setSummary] = useState(initialCasefile.revision?.summary ?? "");
  const [segments, setSegments] = useState(copySegments(initialCasefile));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sessionRecoveryOpen, setSessionRecoveryOpen] = useState(false);
  const [conflict, setConflict] = useState<CasefileConflictSnapshot | null>(null);
  const [activeSegmentId, setActiveSegmentId] = useState(
    initialCasefile.revision?.segments?.[0]?.id ?? null,
  );
  const [seekRequestMs, setSeekRequestMs] = useState<number | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const focusKeyRef = useRef<string | null>(null);
  const scrollPositionRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (dirty || !shouldRefreshCasefile(casefile, initialCasefile)) {
      return;
    }

    setCasefile(initialCasefile);
    setSummary(initialCasefile.revision?.summary ?? "");
    setSegments(copySegments(initialCasefile));
    setActiveSegmentId(initialCasefile.revision?.segments?.[0]?.id ?? null);
  }, [initialCasefile]);

  useEffect(() => {
    if (!dirty) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) {
      return;
    }

    const handleClick = (event: MouseEvent) => {
      const anchor = isNavigableAnchor(event.target) as HTMLAnchorElement | null;
      if (!anchor) {
        return;
      }

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || anchor.target === "_blank") {
        return;
      }

      if (!window.confirm("Leave this casefile and discard unsaved transcript changes?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [dirty]);

  useEffect(() => {
    const handleFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.dataset.editorKey) {
        return;
      }

      focusKeyRef.current = target.dataset.editorKey;
    };

    document.addEventListener("focusin", handleFocus);
    return () => document.removeEventListener("focusin", handleFocus);
  }, []);

  const editable = casefile.capabilities.canEdit && !casefile.access.historical && !phoneSafetyMode;
  const submitEnabled = casefile.capabilities.canSubmit && !phoneSafetyMode;

  const nextCasefileFromResult = (result: CommandResult<CasefileMutationResult>) => {
    if (!result.ok || !result.data.casefile) {
      return null;
    }

    return result.data.casefile;
  };

  function applyMutationResult(result: CommandResult<CasefileMutationResult>) {
    if (!result.ok) {
      if (result.code === "AUTH_EXPIRED") {
        setSessionRecoveryOpen(true);
        return false;
      }

      if (result.code === "STALE_REVISION" && result.latest) {
        setConflict(result.latest);
        return false;
      }

      setLiveMessage(result.message);
      return false;
    }

    const nextCasefile = nextCasefileFromResult(result);
    if (nextCasefile) {
      setCasefile(nextCasefile);
      setSummary(nextCasefile.revision?.summary ?? "");
      setSegments(copySegments(nextCasefile));
      setActiveSegmentId(nextCasefile.revision?.segments?.[0]?.id ?? null);
    }
    setConflict(null);
    setDirty(false);

    requestAnimationFrame(() => {
      if (result.data.focusTarget === "case-state") {
        document.getElementById("case-state")?.focus();
        setLiveMessage(`Case state updated to ${nextCasefile?.stageLabel ?? casefile.stageLabel}.`);
        return;
      }

      if (focusKeyRef.current) {
        document.querySelector<HTMLElement>(`[data-editor-key="${focusKeyRef.current}"]`)?.focus();
      }
      if (
        scrollPositionRef.current &&
        (scrollPositionRef.current.x !== window.scrollX ||
          scrollPositionRef.current.y !== window.scrollY)
      ) {
        window.scrollTo(scrollPositionRef.current.x, scrollPositionRef.current.y);
      }
    });

    return true;
  }

  async function handleSave() {
    if (!dirty || !casefile.capabilities.canSave || phoneSafetyMode || !casefile.revision) {
      return;
    }

    setSaving(true);
    scrollPositionRef.current = { x: window.scrollX, y: window.scrollY };
    const result = await saveAction({
      recordingId: casefile.recordingId,
      expectedCurrentRevisionId: casefile.revision.id,
      summary,
      segments,
      actionModeId: casefile.actionMode?.id ?? null,
    });
    applyMutationResult(result);
    setSaving(false);
  }

  async function handleSubmit() {
    if (!submitEnabled || phoneSafetyMode || !casefile.revision) {
      return;
    }

    setSubmitting(true);
    const result = await submitAction({
      recordingId: casefile.recordingId,
      expectedCurrentRevisionId: casefile.revision.id,
      summary,
      segments,
      hasUnsavedChanges: dirty,
      actionModeId: casefile.actionMode?.id ?? null,
    });
    applyMutationResult(result);
    setSubmitting(false);
  }

  function updateSummary(nextSummary: string) {
    setSummary(nextSummary);
    setDirty(true);
  }

  function updateSpeaker(segmentId: string, value: string) {
    setSegments((current) =>
      current.map((segment) =>
        segment.id === segmentId ? { ...segment, speakerLabel: value } : segment,
      ),
    );
    setDirty(true);
  }

  function updateText(segmentId: string, value: string) {
    setSegments((current) =>
      current.map((segment) => (segment.id === segmentId ? { ...segment, text: value } : segment)),
    );
    setDirty(true);
  }

  const currentCasefileLatestHref = useMemo(
    () => latestHref(casefile, conflict),
    [casefile, conflict],
  );
  const statusPoller = casefile.processing.active ? (
    <OrchestrationStatusPoller
      currentRevisionId={casefile.revision?.id ?? null}
      integrityState={casefile.processing.integrityState}
      recordingId={casefile.recordingId}
      transcriptJobState={casefile.processing.transcriptJobState}
    />
  ) : null;

  if (casefile.statusOnly) {
    return (
      <>
        {statusPoller}
        <UploaderStatusCasefile casefile={casefile} />
      </>
    );
  }

  return (
    <div className="casefile-page">
      <span aria-live="polite" className="sr-only" role="status">
        {liveMessage}
      </span>

      {statusPoller}

      <CaseHeader casefile={casefile} />

      {conflict ? (
        <ConflictPanel
          conflict={conflict}
          latestHref={currentCasefileLatestHref}
          onDiscard={() => {
            window.location.assign(currentCasefileLatestHref);
          }}
        />
      ) : null}

      <div className="casefile-layout">
        <main className="casefile-main" id="transcript-main">
          <MediaTransport
            activeSegmentId={activeSegmentId}
            mediaDenialReason={casefile.media.denialReason}
            mediaKind={casefile.media.kind}
            mediaUrl={casefile.media.url}
            onActiveSegmentChange={setActiveSegmentId}
            onSeekHandled={() => setSeekRequestMs(null)}
            seekRequestMs={seekRequestMs}
            segments={segments}
          />
          <TranscriptDocument
            activeSegmentId={activeSegmentId}
            editable={editable}
            onSeek={(startMs) => setSeekRequestMs(startMs)}
            onSummaryChange={updateSummary}
            onUpdateSpeaker={updateSpeaker}
            onUpdateText={updateText}
            phoneSafetyMode={phoneSafetyMode}
            segments={segments}
            summary={summary}
          />
        </main>
        <GovernanceDrawer casefile={casefile} />
      </div>

      <StateActionBar
        assignmentLabel={casefile.assignmentLabel}
        canSave={casefile.capabilities.canSave}
        canSubmit={submitEnabled}
        dirty={dirty}
        onSave={() => {
          void handleSave();
        }}
        onSubmit={() => {
          void handleSubmit();
        }}
        phoneSafetyMode={phoneSafetyMode}
        saving={saving}
        stageLabel={casefile.stageLabel}
        submitting={submitting}
      />

      <SessionRecoveryDialog
        onClose={() => setSessionRecoveryOpen(false)}
        onRecovered={() => setSessionRecoveryOpen(false)}
        open={sessionRecoveryOpen}
      />
    </div>
  );
}
