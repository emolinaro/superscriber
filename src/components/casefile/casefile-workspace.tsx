"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ApproveRevisionCommandInput,
  ReopenRevisionCommandInput,
  RequestChangesCommandInput,
  SaveDraftCommandInput,
  SubmitRevisionCommandInput,
  WithdrawRevisionCommandInput,
} from "@/server/casefile/commands";
import type {
  EnterAdminActionModeResult,
  ExitAdminActionModeResult,
} from "@/server/actions/admin-action-mode-actions";
import type { CasefileMutationResult } from "@/server/actions/casefile-actions";
import type { CasefileViewModel } from "@/server/casefile/read-model";
import type { CasefileConflictSnapshot } from "@/server/casefile/errors";
import type { CommandResult } from "@/lib/command-result";
import { OrchestrationStatusPoller } from "@/components/orchestration-status-poller";
import { SessionRecoveryDialog } from "@/components/auth/session-recovery-dialog";
import { InlineNotice } from "@/components/ui/inline-notice";
import { appendQueryMessages } from "@/lib/navigation-path";
import { usePhoneSafetyMode } from "@/components/ui/phone-safety";
import { AdminActionModeBanner, type AdminActionModeResult } from "./admin-action-mode-banner";
import { CaseHeader } from "./case-header";
import {
  DecisionDialog,
  type DecisionDialogResult,
  type DecisionKind,
} from "./decision-dialog";
import { ConflictPanel } from "./conflict-panel";
import { ExportDialog } from "./export-dialog";
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

type WithdrawAction = (
  input: WithdrawRevisionCommandInput,
) => Promise<CommandResult<CasefileMutationResult>>;

type RequestChangesAction = (
  input: RequestChangesCommandInput,
) => Promise<CommandResult<CasefileMutationResult>>;

type ApproveAction = (
  input: ApproveRevisionCommandInput,
) => Promise<CommandResult<CasefileMutationResult>>;

type ReopenAction = (
  input: ReopenRevisionCommandInput,
) => Promise<CommandResult<CasefileMutationResult>>;

type EnterAdminActionModeAction = (input: {
  recordingId: string;
  effectiveRole: "reviewer" | "approver";
  purpose: string;
}) => Promise<CommandResult<EnterAdminActionModeResult>>;

type ExitAdminActionModeAction = (input: {
  recordingId: string;
  actionModeId: string;
}) => Promise<CommandResult<ExitAdminActionModeResult>>;

function copySegments(casefile: CasefileViewModel) {
  return casefile.revision?.segments?.map((segment) => ({ ...segment })) ?? [];
}

function latestHref(casefile: CasefileViewModel, conflict?: CasefileConflictSnapshot | null) {
  const searchParams = new URLSearchParams();
  const revisionId = conflict?.currentRevisionId ?? casefile.revision?.id ?? null;

  if (revisionId) {
    searchParams.set("revision", revisionId);
  }
  if (casefile.actionMode?.id) {
    searchParams.set("actionMode", casefile.actionMode.id);
  }

  const search = searchParams.toString();
  return `/recordings/${casefile.recordingId}${search ? `?${search}` : ""}`;
}

function isNavigableAnchor(target: EventTarget | null) {
  return target instanceof HTMLElement ? target.closest("a[href]") : null;
}

function hasActionModeIdentityChanged(current: CasefileViewModel, next: CasefileViewModel) {
  return (
    current.actionMode?.id !== next.actionMode?.id ||
    current.actionMode?.effectiveRole !== next.actionMode?.effectiveRole ||
    current.actionMode?.expiresAt !== next.actionMode?.expiresAt ||
    current.actionMode?.purpose !== next.actionMode?.purpose ||
    current.actionMode?.adminDisplayName !== next.actionMode?.adminDisplayName ||
    current.actionMode?.baseRole !== next.actionMode?.baseRole
  );
}

function isSameRevisionSnapshot(current: CasefileViewModel, next: CasefileViewModel) {
  return current.updatedAt === next.updatedAt && current.revision?.id === next.revision?.id;
}

function shouldRefreshCasefile(current: CasefileViewModel, next: CasefileViewModel) {
  return (
    current.updatedAt !== next.updatedAt ||
    current.revision?.id !== next.revision?.id ||
    hasActionModeIdentityChanged(current, next)
  );
}

function stripActionMode(current: CasefileViewModel, expired = false): CasefileViewModel {
  const governedKeys = [
    "canEdit",
    "canSave",
    "canSubmit",
    "canWithdraw",
    "canApprove",
    "canRequestChanges",
    "canReopen",
    "canExport",
  ] as const;
  const denial = expired ? "admin_action_mode_expired" : "admin_action_mode_required";

  return {
    ...current,
    actionMode: null,
    capabilities:
      current.access.kind === "admin_oversight"
        ? {
            ...current.capabilities,
            canEdit: false,
            canSave: false,
            canSubmit: false,
            canWithdraw: false,
            canApprove: false,
            canRequestChanges: false,
            canReopen: false,
            canExport: false,
            denials: {
              ...current.capabilities.denials,
              canEdit: denial,
              canSave: denial,
              canSubmit: denial,
              canWithdraw: denial,
              canApprove: denial,
              canRequestChanges: denial,
              canReopen: denial,
              canExport: denial,
            },
          }
        : current.capabilities,
    nextActions: current.nextActions.filter(
      (action) => !governedKeys.includes(action.capability as (typeof governedKeys)[number]),
    ),
  };
}

function latestApprovedDecision(casefile: CasefileViewModel) {
  for (let index = casefile.decisions.length - 1; index >= 0; index -= 1) {
    const decision = casefile.decisions[index];
    if (decision?.state === "approved") {
      return decision;
    }
  }

  return null;
}

function CasefileStatusCards({ casefile }: { casefile: CasefileViewModel }) {
  return (
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
  );
}

function unresolvedCasefileNotice(casefile: CasefileViewModel, conflict: CasefileConflictSnapshot | null) {
  if (conflict) {
    return null;
  }

  if (casefile.processing.active) {
    return {
      tone: "warning" as const,
      message: "Transcript processing is still running. Check the progress below.",
    };
  }

  if (!casefile.revision) {
    return {
      tone: "danger" as const,
      message: "Transcript processing completed without a revision.",
    };
  }

  return null;
}

function UploaderStatusCasefile({ casefile }: { casefile: CasefileViewModel }) {
  return (
    <section className="casefile-status-only" aria-label="Recording status">
      <CaseHeader casefile={casefile} />
      <CasefileStatusCards casefile={casefile} />
    </section>
  );
}

export function CasefileWorkspace({
  initialCasefile,
  saveAction,
  submitAction,
  withdrawAction,
  requestChangesAction,
  approveAction,
  reopenAction,
  enterAdminActionModeAction,
  exitAdminActionModeAction,
}: {
  initialCasefile: CasefileViewModel;
  saveAction: SaveAction;
  submitAction: SubmitAction;
  withdrawAction: WithdrawAction;
  requestChangesAction: RequestChangesAction;
  approveAction: ApproveAction;
  reopenAction: ReopenAction;
  enterAdminActionModeAction: EnterAdminActionModeAction;
  exitAdminActionModeAction: ExitAdminActionModeAction;
}) {
  const router = useRouter();
  const phoneSafetyMode = usePhoneSafetyMode();
  const [casefile, setCasefile] = useState(initialCasefile);
  const [summary, setSummary] = useState(initialCasefile.revision?.summary ?? "");
  const [segments, setSegments] = useState(copySegments(initialCasefile));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sessionRecoveryOpen, setSessionRecoveryOpen] = useState(false);
  const [conflict, setConflict] = useState<CasefileConflictSnapshot | null>(null);
  const [activeDecision, setActiveDecision] = useState<DecisionKind | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [activeSegmentId, setActiveSegmentId] = useState(
    initialCasefile.revision?.segments?.[0]?.id ?? null,
  );
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [seekRequestMs, setSeekRequestMs] = useState<number | null>(null);
  const [liveMessage, setLiveMessage] = useState("");
  const focusKeyRef = useRef<string | null>(null);
  const scrollPositionRef = useRef<{ x: number; y: number } | null>(null);
  const casefileRef = useRef(casefile);
  const dirtyRef = useRef(dirty);

  useEffect(() => {
    casefileRef.current = casefile;
    dirtyRef.current = dirty;
  }, [casefile, dirty]);

  useEffect(() => {
    const currentCasefile = casefileRef.current;
    const currentDirty = dirtyRef.current;

    if (!shouldRefreshCasefile(currentCasefile, initialCasefile)) {
      return;
    }

    if (currentDirty && !isSameRevisionSnapshot(currentCasefile, initialCasefile)) {
      return;
    }

    setCasefile(initialCasefile);

    if (currentDirty) {
      return;
    }

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

  const unresolved = conflict !== null || casefile.processing.active || !casefile.revision;
  const unresolvedNotice = unresolvedCasefileNotice(casefile, conflict);
  const editable =
    casefile.capabilities.canEdit &&
    !casefile.access.historical &&
    !phoneSafetyMode &&
    !unresolved;
  const approvedDecision = latestApprovedDecision(casefile);
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

  function replaceCasefileHref(href: string) {
    router.replace(href, { scroll: false });
  }

  function handleActionModeLoss(message: string, expired = false) {
    const nextCasefile = stripActionMode(casefile, expired);
    setCasefile(nextCasefile);
    replaceCasefileHref(latestHref(nextCasefile, conflict));
    setLiveMessage(message);
  }

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

      if (
        result.code === "ACTION_MODE_EXPIRED" ||
        result.code === "ACTION_MODE_ENDED" ||
        result.code === "ACTION_MODE_REQUIRED"
      ) {
        handleActionModeLoss(result.message, result.code === "ACTION_MODE_EXPIRED");
        return false;
      }

      if (result.code === "STATE_CHANGED") {
        setActiveDecision(null);
        router.refresh();
        setLiveMessage(result.message);
        return false;
      }

      setLiveMessage(result.message);
      return false;
    }

    const nextCasefile = result.data.casefile;
    if (!nextCasefile) {
      setDirty(false);
      setConflict(null);
      router.push(appendQueryMessages(result.data.nextPath, { notice: result.notice }));
      return true;
    }

    setCasefile(nextCasefile);
    setSummary(nextCasefile.revision?.summary ?? "");
    setSegments(copySegments(nextCasefile));
    setActiveSegmentId(nextCasefile.revision?.segments?.[0]?.id ?? null);
    setConflict(null);
    setDirty(false);
    setLiveMessage(result.notice ?? `Case state updated to ${nextCasefile.stageLabel}.`);

    requestAnimationFrame(() => {
      if (result.data.focusTarget === "case-state") {
        document.getElementById("case-state")?.focus();
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

  async function runDecision(kind: DecisionKind, detail: { reason: string; note: string }): Promise<DecisionDialogResult> {
    if (phoneSafetyMode || !casefile.revision) {
      return { ok: false };
    }

    let result: CommandResult<CasefileMutationResult>;

    if (kind === "submit") {
      result = await submitAction({
        recordingId: casefile.recordingId,
        expectedCurrentRevisionId: casefile.revision.id,
        summary,
        segments,
        hasUnsavedChanges: dirty,
        actionModeId: casefile.actionMode?.id ?? null,
      });
    } else if (kind === "withdraw") {
      result = await withdrawAction({
        recordingId: casefile.recordingId,
        expectedPendingRevisionId: casefile.revision.id,
        reason: detail.reason,
        actionModeId: casefile.actionMode?.id ?? null,
      });
    } else if (kind === "requestChanges") {
      result = await requestChangesAction({
        recordingId: casefile.recordingId,
        expectedPendingRevisionId: casefile.revision.id,
        reason: detail.reason,
        actionModeId: casefile.actionMode?.id ?? null,
      });
    } else if (kind === "approve") {
      result = await approveAction({
        recordingId: casefile.recordingId,
        expectedPendingRevisionId: casefile.revision.id,
        note: detail.note,
        actionModeId: casefile.actionMode?.id ?? null,
      });
    } else {
      result = await reopenAction({
        recordingId: casefile.recordingId,
        expectedApprovedRevisionId: casefile.revision.id,
        reason: detail.reason,
        actionModeId: casefile.actionMode?.id ?? null,
      });
    }

    if (!result.ok) {
      if (result.code === "AUTH_EXPIRED") {
        setSessionRecoveryOpen(true);
        return { ok: false };
      }

      if (result.code === "STATE_CHANGED") {
        setActiveDecision(null);
        router.refresh();
        setLiveMessage(result.message);
        return { ok: false };
      }

      if (result.code === "STALE_REVISION" && result.latest) {
        setConflict(result.latest);
        setActiveDecision(null);
        return { ok: false };
      }

      if (
        result.code === "ACTION_MODE_EXPIRED" ||
        result.code === "ACTION_MODE_ENDED" ||
        result.code === "ACTION_MODE_REQUIRED"
      ) {
        handleActionModeLoss(result.message, result.code === "ACTION_MODE_EXPIRED");
        setActiveDecision(null);
        return { ok: true };
      }

      return { ok: false, error: result.message };
    }

    applyMutationResult(result);
    setActiveDecision(null);
    return { ok: true };
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

  async function handleEnterActionMode(input: {
    effectiveRole: "reviewer" | "approver";
    purpose: string;
  }): Promise<AdminActionModeResult> {
    if (phoneSafetyMode) {
      return { ok: false };
    }

    const result = await enterAdminActionModeAction({
      recordingId: casefile.recordingId,
      effectiveRole: input.effectiveRole,
      purpose: input.purpose,
    });

    if (!result.ok) {
      if (result.code === "AUTH_EXPIRED") {
        setSessionRecoveryOpen(true);
        return { ok: false };
      }

      return { ok: false, error: result.message };
    }

    replaceCasefileHref(result.data.href);
    setLiveMessage(result.notice ?? "Admin action mode entered.");
    return { ok: true };
  }

  async function handleExitActionMode(): Promise<AdminActionModeResult> {
    if (!casefile.actionMode) {
      return { ok: true };
    }

    const result = await exitAdminActionModeAction({
      recordingId: casefile.recordingId,
      actionModeId: casefile.actionMode.id,
    });

    if (!result.ok) {
      if (result.code === "AUTH_EXPIRED") {
        setSessionRecoveryOpen(true);
        return { ok: false };
      }

      if (result.code === "ACTION_MODE_EXPIRED" || result.code === "ACTION_MODE_ENDED") {
        handleActionModeLoss(result.message, result.code === "ACTION_MODE_EXPIRED");
        return { ok: true };
      }

      return { ok: false, error: result.message };
    }

    replaceCasefileHref(result.data.href);
    setLiveMessage(result.notice ?? "Admin action mode exited.");
    return { ok: true };
  }

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

      {casefile.revision ? (
        <AdminActionModeBanner
          entryOptions={casefile.adminActionModeOptions}
          onEnter={handleEnterActionMode}
          onExit={handleExitActionMode}
          phoneSafetyMode={phoneSafetyMode}
          recordingTitle={casefile.title}
          session={casefile.actionMode}
        />
      ) : null}

      {conflict ? (
        <ConflictPanel
          conflict={conflict}
          latestHref={currentCasefileLatestHref}
          onDiscard={() => {
            window.location.assign(currentCasefileLatestHref);
          }}
        />
      ) : null}

      <div
        className="casefile-layout"
        data-governance-open={governanceOpen ? "true" : undefined}
      >
        <div className="casefile-main" id="transcript-main">
          {unresolvedNotice ? (
            <InlineNotice tone={unresolvedNotice.tone}>{unresolvedNotice.message}</InlineNotice>
          ) : null}

          {casefile.revision ? (
            <>
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
            </>
          ) : (
            <CasefileStatusCards casefile={casefile} />
          )}
        </div>
        <GovernanceDrawer casefile={casefile} onOpenChange={setGovernanceOpen} />
      </div>

      <StateActionBar
        assignmentLabel={casefile.assignmentLabel}
        canApprove={!unresolved && casefile.capabilities.canApprove}
        canExport={!unresolved && casefile.capabilities.canExport}
        canReopen={!unresolved && casefile.capabilities.canReopen}
        canRequestChanges={!unresolved && casefile.capabilities.canRequestChanges}
        canSave={!unresolved && casefile.capabilities.canSave}
        canSubmit={!unresolved && casefile.capabilities.canSubmit}
        canWithdraw={!unresolved && casefile.capabilities.canWithdraw}
        dirty={dirty}
        onApprove={() => {
          if (!phoneSafetyMode) {
            setActiveDecision("approve");
          }
        }}
        onExport={() => {
          if (!phoneSafetyMode) {
            setExportOpen(true);
          }
        }}
        onReopen={() => {
          if (!phoneSafetyMode) {
            setActiveDecision("reopen");
          }
        }}
        onRequestChanges={() => {
          if (!phoneSafetyMode) {
            setActiveDecision("requestChanges");
          }
        }}
        onSave={() => {
          void handleSave();
        }}
        onSubmit={() => {
          if (!phoneSafetyMode) {
            setActiveDecision("submit");
          }
        }}
        onWithdraw={() => {
          if (!phoneSafetyMode) {
            setActiveDecision("withdraw");
          }
        }}
        phoneSafetyMode={phoneSafetyMode}
        saving={saving}
        stageLabel={casefile.stageLabel}
      />

      {activeDecision && casefile.revision ? (
        <DecisionDialog
          kind={activeDecision}
          onCancel={() => setActiveDecision(null)}
          onConfirm={(detail) => runDecision(activeDecision, detail)}
          open={!phoneSafetyMode}
          revision={casefile.revision}
        />
      ) : null}

      {exportOpen && casefile.revision ? (
        <ExportDialog
          actionModeId={casefile.actionMode?.id ?? null}
          approvedAt={approvedDecision?.createdAt ?? casefile.revision.approvedAt ?? null}
          approvedBy={approvedDecision?.actorDisplay ?? null}
          onAnnouncement={(message) => setLiveMessage(message)}
          onClose={() => setExportOpen(false)}
          onSessionRecoveryRequested={() => setSessionRecoveryOpen(true)}
          open={!phoneSafetyMode}
          recordingId={casefile.recordingId}
          revision={{ version: casefile.revision.version }}
        />
      ) : null}

      <SessionRecoveryDialog
        onClose={() => setSessionRecoveryOpen(false)}
        onRecovered={() => setSessionRecoveryOpen(false)}
        open={sessionRecoveryOpen}
      />
    </div>
  );
}
