import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import {
  authExpiredIngestFailure,
  describeIngestFailure,
  finalizeResumableUploadSession,
  IngestError,
} from "@/server/ingest/service";
import { getActivePrincipal } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ sessionId: string }>;

export async function POST(
  _request: Request,
  context: { params: Params },
) {
  const principal = await getActivePrincipal();
  if (!principal) {
    const failure = authExpiredIngestFailure();
    return NextResponse.json(failure.body, { status: failure.status });
  }
  if (principal.role !== "uploader" && principal.role !== "admin") {
    const failure = describeIngestFailure(
      new IngestError(
        "ACCESS_DENIED",
        "Only uploader and admin accounts can finalize ingest sessions.",
      ),
    );
    return NextResponse.json(failure.body, { status: failure.status });
  }

  try {
    const { sessionId } = await context.params;
    const status = await finalizeResumableUploadSession(sessionId, principal);
    revalidatePath("/workspace");
    revalidatePath(`/recordings/${status.recordingId}`);
    return NextResponse.json({
      ok: true,
      status,
      nextPath:
        principal.role === "admin" ? `/recordings/${status.recordingId}` : "/workspace",
    });
  } catch (error) {
    const failure = describeIngestFailure(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
