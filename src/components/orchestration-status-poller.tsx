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
  integrityState: string;
  transcriptJobState: string;
  currentRevisionId: string | null;
  updatedAt: string;
};

function isActiveStatus(snapshot: StatusSnapshot) {
  return (
    snapshot.currentRevisionId === null &&
    (snapshot.integrityState === "verifying" ||
      snapshot.transcriptJobState === "queued" ||
      snapshot.transcriptJobState === "running" ||
      snapshot.transcriptJobState === "partial_result")
  );
}

export function OrchestrationStatusPoller(props: PollerProps) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<StatusSnapshot>({
    integrityState: props.integrityState,
    transcriptJobState: props.transcriptJobState,
    currentRevisionId: props.currentRevisionId,
    updatedAt: "",
  });
  const [pollState, setPollState] = useState<"idle" | "watching" | "finalized" | "error">(
    isActiveStatus({
      integrityState: props.integrityState,
      transcriptJobState: props.transcriptJobState,
      currentRevisionId: props.currentRevisionId,
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
        nextSnapshot.integrityState !== snapshot.integrityState ||
        nextSnapshot.transcriptJobState !== snapshot.transcriptJobState ||
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
        integrityState: props.integrityState,
        transcriptJobState: props.transcriptJobState,
        currentRevisionId: props.currentRevisionId,
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
