import { NextResponse } from "next/server";
import { parseApprovedTranscriptExportFormat } from "@/lib/approved-transcript-export";
import { resolveApprovedTranscriptExportForPrincipal } from "@/server/repository";
import { getActivePrincipal } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ recordingId: string }>;

function toResponseBody(bytes: Uint8Array) {
  return new Blob([new Uint8Array(bytes)], {
    type: "application/octet-stream",
  });
}

export async function GET(
  request: Request,
  context: { params: Params },
) {
  const principal = await getActivePrincipal();
  if (!principal) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const requestedFormat = searchParams.get("format");
  const format =
    requestedFormat === null
      ? "txt"
      : parseApprovedTranscriptExportFormat(requestedFormat);
  if (format === null) {
    return new NextResponse("Unsupported transcript export format.", {
      status: 400,
    });
  }

  const { recordingId } = await context.params;
  const exportResult = await resolveApprovedTranscriptExportForPrincipal(
    recordingId,
    principal,
    format,
  );
  if (!exportResult) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (exportResult.denied) {
    return new NextResponse(exportResult.reason, { status: 403 });
  }
  if (exportResult.missing) {
    return new NextResponse("No approved transcript is available for export.", {
      status: 409,
    });
  }

  return new NextResponse(toResponseBody(exportResult.body), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": exportResult.contentType,
      "content-disposition": `attachment; filename="${exportResult.fileName}"`,
    },
  });
}
