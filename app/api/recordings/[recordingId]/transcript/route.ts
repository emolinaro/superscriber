import { NextResponse } from "next/server";
import { resolveApprovedTranscriptExportForPrincipal } from "@/server/repository";
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
  const exportResult = await resolveApprovedTranscriptExportForPrincipal(
    recordingId,
    principal,
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

  const responseBody = new Uint8Array(exportResult.body).buffer;

  return new NextResponse(responseBody, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": exportResult.contentType,
      "content-disposition": `attachment; filename="${exportResult.fileName}"`,
    },
  });
}
