import { readSynchronizedState } from "@/server/store";
import { getOrchestrationConfig } from "@/server/orchestration/config";
import { noteRecordingDispatchFailure } from "@/server/repository";

export type DispatchResult = {
  mode: "mock" | "internal" | "webhook";
  dispatched: boolean;
  message: string;
};

export async function dispatchRecordingToConfiguredEngine(
  recordingId: string,
): Promise<DispatchResult> {
  const config = getOrchestrationConfig();
  if (config.mode === "mock") {
    return {
      mode: "mock",
      dispatched: false,
      message: "Using mock orchestration mode. No external engine dispatch was attempted.",
    };
  }

  if (config.mode === "internal") {
    return {
      mode: "internal",
      dispatched: false,
      message: "Using internal worker mode. Queued jobs are picked up by the local Python worker.",
    };
  }

  if (!config.externalDispatchUrl) {
    const message =
      "External orchestration mode is enabled, but SUPERSCRIBER_ENGINE_DISPATCH_URL is missing.";
    noteRecordingDispatchFailure({ recordingId, detail: message });
    throw new Error(message);
  }

  if (!config.appBaseUrl) {
    const message =
      "External orchestration mode is enabled, but SUPERSCRIBER_APP_BASE_URL is missing.";
    noteRecordingDispatchFailure({ recordingId, detail: message });
    throw new Error(message);
  }

  const state = readSynchronizedState();
  const recording = state.recordings.find((entry) => entry.id === recordingId);
  const workspace = recording
    ? state.workspaces.find((entry) => entry.id === recording.workspaceId)
    : null;
  const ingestionSession = recording
    ? state.ingestionSessions.find((entry) => entry.id === recording.ingestionSessionId)
    : null;
  const transcriptJob = recording
    ? state.transcriptJobs.find((entry) => entry.id === recording.transcriptJobId)
    : null;

  if (!recording || !workspace || !ingestionSession || !transcriptJob) {
    const message =
      "Recording orchestration state is incomplete and could not be dispatched.";
    noteRecordingDispatchFailure({ recordingId, detail: message });
    throw new Error(message);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.dispatchTimeoutMs);

  try {
    const response = await fetch(config.externalDispatchUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.sharedSecret
          ? { authorization: `Bearer ${config.sharedSecret}` }
          : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        recordingId: recording.id,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          policyProfileId: workspace.policyProfileId,
        },
        recording: {
          title: recording.title,
          source: recording.source,
          mediaKind: recording.mediaKind,
          mimeType: recording.mimeType,
          mediaPath: recording.mediaPath,
          originalFileName: recording.originalFileName,
          languageHint: recording.languageHint,
          uploadedByRole: recording.uploadedByRole,
          createdAt: recording.createdAt,
        },
        ingestionSession: {
          id: ingestionSession.id,
          state: ingestionSession.state,
          resumeToken: ingestionSession.resumeToken,
        },
        transcriptJob: {
          id: transcriptJob.id,
          state: transcriptJob.state,
        },
        callbacks: {
          orchestrationUpdateUrl: `${config.appBaseUrl}/api/orchestration/callback`,
          statusUrl: `${config.appBaseUrl}/api/recordings/${recording.id}/status`,
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const message = `External engine dispatch failed with ${response.status}: ${detail || "no response body"}`;
      noteRecordingDispatchFailure({ recordingId, detail: message });
      throw new Error(message);
    }

    return {
      mode: "webhook",
      dispatched: true,
      message: "Recording dispatched to the configured external orchestration engine.",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "External engine dispatch failed.";
    noteRecordingDispatchFailure({ recordingId, detail: message });
    throw new Error(message);
  } finally {
    clearTimeout(timeoutId);
  }
}
