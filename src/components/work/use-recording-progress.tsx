"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { TranscriptionProgressBar } from "@/components/ui/transcription-progress";

export type RecordingProgressSample = {
  recordingId: string;
  state: string;
  progressPercent: number | null;
  transcribedUntilMs: number | null;
  audioDurationMs: number | null;
  segmentsSeen: number | null;
  updatedAt: string;
};

const POLL_MS = 2_500;
const IN_FLIGHT = new Set(["queued", "running", "partial_result"]);

// Light polling over the batch progress endpoint for the work list. Newest
// sample per recording wins; when a job leaves the in-flight states, ONE
// router refresh reconciles the governed labels (no stale pins).
export function useRecordingProgress(recordingIds: string[]) {
  const router = useRouter();
  const [samples, setSamples] = useState<Record<string, RecordingProgressSample>>({});
  const completedNotifiedRef = useRef(new Set<string>());
  const idsKey = recordingIds.slice().sort().join(",");

  useEffect(() => {
    if (!idsKey) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    async function poll() {
      try {
        const response = await fetch(`/api/recordings/progress?ids=${encodeURIComponent(idsKey)}`, {
          cache: "no-store",
        });
        if (!response.ok || cancelled) {
          return;
        }
        const body = (await response.json()) as { jobs: RecordingProgressSample[] };
        const next: Record<string, RecordingProgressSample> = {};
        for (const job of body.jobs) {
          next[job.recordingId] = job;
        }
        if (cancelled) {
          return;
        }
        setSamples(next);

        let needsRefresh = false;
        for (const job of body.jobs) {
          if (!IN_FLIGHT.has(job.state) && !completedNotifiedRef.current.has(job.recordingId)) {
            completedNotifiedRef.current.add(job.recordingId);
            needsRefresh = true;
          }
        }
        if (!cancelled && needsRefresh) {
          router.refresh();
        }
      } catch {
        // Line failures stay quiet; the next cycle retries.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(poll, POLL_MS);
        }
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
    // idsKey (stable string) is the dependency; recordingIds re-renders often.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, router]);

  return samples;
}

export function ProgressAwareStatus({
  fallbackLabel,
  sample,
}: {
  fallbackLabel: string;
  sample: RecordingProgressSample | undefined;
}) {
  if (!sample || !IN_FLIGHT.has(sample.state)) {
    return <>{fallbackLabel}</>;
  }
  if (sample.state === "queued" && sample.progressPercent === null && !sample.segmentsSeen) {
    return <>Queued for transcription</>;
  }
  return (
    <TranscriptionProgressBar
      tone="compact"
      audioDurationMs={sample.audioDurationMs}
      percent={sample.progressPercent}
      segmentsSeen={sample.segmentsSeen}
      transcribedUntilMs={sample.transcribedUntilMs}
    />
  );
}
