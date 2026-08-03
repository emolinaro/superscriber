"use client";

import { useEffect, useRef, useState, startTransition } from "react";
import { useRouter } from "next/navigation";

type PollerProps = {
  recordingId: string;
  integrityState: string;
  transcriptJobState: string;
  currentRevisionId: string | null;
};

type StatusSnapshot = {
  workflowStage: string;
  currentRevisionVersion: number | null;
  currentRevisionId: string | null;
  approvedRevisionId: string | null;
  pendingRevisionId: string | null;
  progress: {
    integrityState: string;
    transcriptJobState: string;
    transcriptJobProgressPercent: number | null;
    transcriptJobEtaSeconds: number | null;
  };
  updatedAt: string;
};

function isActiveStatus(snapshot: StatusSnapshot) {
  return (
    snapshot.progress.integrityState === "verifying" ||
    snapshot.progress.transcriptJobState === "queued" ||
    snapshot.progress.transcriptJobState === "running" ||
    snapshot.progress.transcriptJobState === "partial_result"
  );
}

function progressBoundary(value: number | null) {
  if (value === null) {
    return null;
  }

  return Math.floor(value / 10) * 10;
}

function labelForStage(stage: string) {
  return stage.replace(/_/g, " ");
}

export function OrchestrationStatusPoller(props: PollerProps) {
  const router = useRouter();
  const [announcement, setAnnouncement] = useState("");
  const [snapshot, setSnapshot] = useState<StatusSnapshot>({
    workflowStage: "draft_review",
    currentRevisionVersion: null,
    currentRevisionId: props.currentRevisionId,
    approvedRevisionId: null,
    pendingRevisionId: null,
    progress: {
      integrityState: props.integrityState,
      transcriptJobState: props.transcriptJobState,
      transcriptJobProgressPercent: null,
      transcriptJobEtaSeconds: null,
    },
    updatedAt: "",
  });
  const lastStageRef = useRef("draft_review");
  const lastBoundaryRef = useRef<number | null>(null);

  useEffect(() => {
    const nextSnapshot = {
      workflowStage: snapshot.workflowStage,
      currentRevisionVersion: snapshot.currentRevisionVersion,
      currentRevisionId: props.currentRevisionId,
      approvedRevisionId: snapshot.approvedRevisionId,
      pendingRevisionId: snapshot.pendingRevisionId,
      progress: {
        integrityState: props.integrityState,
        transcriptJobState: props.transcriptJobState,
        transcriptJobProgressPercent: snapshot.progress.transcriptJobProgressPercent,
        transcriptJobEtaSeconds: snapshot.progress.transcriptJobEtaSeconds,
      },
      updatedAt: snapshot.updatedAt,
    };
    setSnapshot(nextSnapshot);
  }, [props.currentRevisionId, props.integrityState, props.transcriptJobState]);

  useEffect(() => {
    if (!isActiveStatus(snapshot)) {
      return;
    }

    let cancelled = false;

    async function pollStatus() {
      try {
        const response = await fetch(`/api/recordings/${props.recordingId}/status`, {
          cache: "no-store",
        });
        if (!response.ok || cancelled) {
          return;
        }

        const nextSnapshot = (await response.json()) as StatusSnapshot;
        const nextBoundary = progressBoundary(
          nextSnapshot.progress.transcriptJobProgressPercent,
        );

        if (nextSnapshot.workflowStage !== lastStageRef.current) {
          lastStageRef.current = nextSnapshot.workflowStage;
          setAnnouncement(`Case stage updated to ${labelForStage(nextSnapshot.workflowStage)}.`);
        } else if (
          nextBoundary !== null &&
          nextBoundary !== lastBoundaryRef.current &&
          nextBoundary > (lastBoundaryRef.current ?? -10)
        ) {
          lastBoundaryRef.current = nextBoundary;
          setAnnouncement(`Transcript processing reached ${nextBoundary} percent.`);
        }

        if (
          nextSnapshot.updatedAt !== snapshot.updatedAt ||
          nextSnapshot.currentRevisionId !== snapshot.currentRevisionId ||
          nextSnapshot.progress.integrityState !== snapshot.progress.integrityState ||
          nextSnapshot.progress.transcriptJobState !== snapshot.progress.transcriptJobState
        ) {
          setSnapshot(nextSnapshot);
          startTransition(() => {
            router.refresh();
          });
        } else {
          setSnapshot(nextSnapshot);
        }
      } catch {
        return;
      }
    }

    const timer = window.setInterval(() => {
      void pollStatus();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [props.recordingId, router, snapshot]);

  return announcement ? (
    <span aria-live="polite" className="sr-only" role="status">
      {announcement}
    </span>
  ) : null;
}
