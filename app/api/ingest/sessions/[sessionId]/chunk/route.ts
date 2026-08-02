import { NextResponse } from "next/server";
import {
  appendUploadChunk,
  authExpiredIngestFailure,
  describeIngestFailure,
  IngestError,
} from "@/server/ingest/service";
import { getActivePrincipal } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ sessionId: string }>;

export async function PUT(
  request: Request,
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
        "Only uploader and admin accounts can update ingest sessions.",
      ),
    );
    return NextResponse.json(failure.body, { status: failure.status });
  }

  const startHeader = request.headers.get("x-superscriber-byte-start");
  const chunkStart = startHeader ? Number.parseInt(startHeader, 10) : Number.NaN;
  if (!Number.isFinite(chunkStart) || chunkStart < 0) {
    const failure = describeIngestFailure(
      new IngestError(
        "VALIDATION_ERROR",
        "A valid x-superscriber-byte-start header is required.",
        {
          chunkStart: "A valid x-superscriber-byte-start header is required.",
        },
      ),
    );
    return NextResponse.json(failure.body, { status: failure.status });
  }

  try {
    const { sessionId } = await context.params;
    const buffer = new Uint8Array(await request.arrayBuffer());
    const status = appendUploadChunk({
      principal,
      sessionId,
      chunkStart,
      bytes: buffer,
    });

    return NextResponse.json({ ok: true, status });
  } catch (error) {
    const failure = describeIngestFailure(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
