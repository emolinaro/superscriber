import { NextResponse } from "next/server";
import { getRecordingDetail } from "@/server/repository";
import { getActiveRole } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ recordingId: string }>;

export async function GET(
  _request: Request,
  context: { params: Params },
) {
  const role = await getActiveRole();
  if (!role) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { recordingId } = await context.params;
  const detail = getRecordingDetail(recordingId, role);
  if (!detail) {
    return new NextResponse("Not found", { status: 404 });
  }

  return NextResponse.json({
    recordingId: detail.recording.id,
    ingestionSession: detail.ingestionSession,
    transcriptJob: detail.transcriptJob,
    currentRevisionId: detail.recording.currentRevisionId,
    approvedRevisionId: detail.recording.approvedRevisionId,
    pendingRevisionId: detail.recording.pendingRevisionId,
    integrityState: detail.recording.integrityState,
    transcriptJobState: detail.recording.transcriptJobState,
    verificationSummary: detail.recording.verificationSummary,
    updatedAt: detail.recording.updatedAt,
  });
}
