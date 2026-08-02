"use client";

import { useEffect, useEffectEvent, useRef, useState, startTransition } from "react";
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
    snapshot.currentRevisionId === null &&
    (snapshot.progress.integrityState === "verifying" ||
      snapshot.progress.transcriptJobState === "queued" ||
      snapshot.progress.transcriptJobState === "running" ||
      snapshot.progress.transcriptJobState === "partial_result")
  );
}

export function OrchestrationStatusPoller(props: PollerProps) {
  const router = useRouter();
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
  const [pollState, setPollState] = useState<"idle" | "watching" | "finalized" | "error">(
    isActiveStatus({
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
    })
      ? "watching"
      : "idle",
  );
  const lastRevisionIdRef = useRef(props.currentRevisionId);

  const pollServer = useEffectEvent(async () => {
    try {
      const response = await fetch(`/api/recordings/${props.recordingId}/status`, {
        cache: "no-store",
      });
      if (!response.ok) {
        setPollState("error");
        return;
      }

      const nextSnapshot = (await response.json()) as StatusSnapshot;
      const shouldKeepWatching = isActiveStatus(nextSnapshot);
      if (
        nextSnapshot.progress.integrityState !== snapshot.progress.integrityState ||
        nextSnapshot.progress.transcriptJobState !== snapshot.progress.transcriptJobState ||
        nextSnapshot.currentRevisionId !== lastRevisionIdRef.current ||
        nextSnapshot.updatedAt !== snapshot.updatedAt
      ) {
        lastRevisionIdRef.current = nextSnapshot.currentRevisionId;
        setSnapshot(nextSnapshot);
        startTransition(() => {
          router.refresh();
        });
      }

      setPollState(shouldKeepWatching ? "watching" : "finalized");
    } catch {
      setPollState("error");
    }
  });

  useEffect(() => {
    setSnapshot((current) => {
      const nextSnapshot = {
        workflowStage: current.workflowStage,
        currentRevisionVersion: current.currentRevisionVersion,
        currentRevisionId: props.currentRevisionId,
        approvedRevisionId: current.approvedRevisionId,
        pendingRevisionId: current.pendingRevisionId,
        progress: {
          integrityState: props.integrityState,
          transcriptJobState: props.transcriptJobState,
          transcriptJobProgressPercent: current.progress.transcriptJobProgressPercent,
          transcriptJobEtaSeconds: current.progress.transcriptJobEtaSeconds,
        },
        updatedAt: current.updatedAt,
      };
      lastRevisionIdRef.current = props.currentRevisionId;
      setPollState(isActiveStatus(nextSnapshot) ? "watching" : "idle");
      return nextSnapshot;
    });
  }, [
    props.currentRevisionId,
    props.integrityState,
    props.transcriptJobState,
  ]);

  useEffect(() => {
    if (pollState !== "watching") {
      return;
    }

    const timer = window.setInterval(() => {
      void pollServer();
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [pollServer, pollState]);

  if (pollState === "idle") {
    return null;
  }

  return (
    <div className="banner" data-tone={pollState === "error" ? "danger" : "ok"}>
      {pollState === "watching"
        ? "Live orchestration refresh is active while the first draft is being prepared."
        : pollState === "finalized"
          ? "Initial draft is ready. Live orchestration refresh has stopped."
          : "Live orchestration refresh could not reach the status endpoint."}
    </div>
  );
}
