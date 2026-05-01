import { NextResponse } from "next/server";
import { appendUploadChunk } from "@/server/ingest/service";
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
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (principal.role !== "uploader" && principal.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const startHeader = request.headers.get("x-superscriber-byte-start");
  const chunkStart = startHeader ? Number.parseInt(startHeader, 10) : Number.NaN;
  if (!Number.isFinite(chunkStart) || chunkStart < 0) {
    return NextResponse.json(
      { ok: false, error: "A valid x-superscriber-byte-start header is required." },
      { status: 400 },
    );
  }

  try {
    const { sessionId } = await context.params;
    const buffer = new Uint8Array(await request.arrayBuffer());
    const status = appendUploadChunk({
      sessionId,
      chunkStart,
      bytes: buffer,
    });

    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Chunk upload failed.",
      },
      { status: 409 },
    );
  }
}
