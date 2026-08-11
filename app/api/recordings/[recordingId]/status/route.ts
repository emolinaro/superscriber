import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getCasefile } from "@/server/casefile/read-model";
import { CasefileCommandError } from "@/server/casefile/errors";
import { getAppDbBundle } from "@/server/db/client";
import { recordings, revisions, transcriptJobs } from "@/server/db/schema";
import { getActivePrincipal } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ recordingId: string }>;

export async function GET(
  _request: Request,
  context: { params: Params },
) {
  try {
    const principal = await getActivePrincipal();
    if (!principal) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const { recordingId } = await context.params;
    let casefile;
    try {
      casefile = getCasefile(principal, recordingId);
    } catch (error) {
      if (error instanceof CasefileCommandError && error.code === "ACCESS_DENIED") {
        return new NextResponse(error.message, { status: 403 });
      }
      throw error;
    }

    if (!casefile) {
      return new NextResponse("Not found", { status: 404 });
    }

    const bundle = getAppDbBundle();
    const recording = bundle.db
      .select()
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .get();
    if (!recording) {
      return new NextResponse("Not found", { status: 404 });
    }

    const currentRevision = recording.currentRevisionId
      ? bundle.db.select().from(revisions).where(eq(revisions.id, recording.currentRevisionId)).get()
      : null;
    const transcriptJob = recording.transcriptJobId
      ? bundle.db.select().from(transcriptJobs).where(eq(transcriptJobs.id, recording.transcriptJobId)).get()
      : null;

    return NextResponse.json({
      workflowStage: casefile.stage,
      currentRevisionVersion: currentRevision?.version ?? null,
      currentRevisionId: recording.currentRevisionId,
      approvedRevisionId: recording.approvedRevisionId,
      pendingRevisionId: recording.pendingRevisionId,
      progress: {
        integrityState: recording.integrityState,
        transcriptJobState: recording.transcriptJobState,
        transcriptJobProgressPercent: transcriptJob?.progressPercent ?? null,
        transcriptJobEtaSeconds: transcriptJob?.etaSeconds ?? null,
        transcriptionTranscribedUntilMs: transcriptJob?.transcribedUntilMs ?? null,
        transcriptionAudioDurationMs: transcriptJob?.audioDurationMs ?? null,
        transcriptionSegmentsSeen: transcriptJob?.segmentsSeen ?? null,
      },
      updatedAt: recording.updatedAt,
    });
  } catch {
    return new NextResponse("Unable to load recording status.", { status: 500 });
  }
}
