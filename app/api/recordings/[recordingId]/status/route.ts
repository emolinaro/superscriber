import { NextResponse } from "next/server";
import { canAccessRecording } from "@/server/access/service";
import { getRecordingDetail } from "@/server/repository";
import { getActivePrincipal } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ recordingId: string }>;

export async function GET(
  _request: Request,
  context: { params: Params },
) {
  const principal = await getActivePrincipal();
  if (!principal) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { recordingId } = await context.params;
  const access = canAccessRecording(principal, recordingId);
  if (!access.allowed) {
    return new NextResponse(access.reason ?? "Forbidden", { status: 403 });
  }

  const detail = getRecordingDetail(recordingId, principal.role);
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
