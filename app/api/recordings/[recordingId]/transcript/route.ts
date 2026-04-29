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
  const exportResult = resolveApprovedTranscriptExportForPrincipal(recordingId, principal);
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

  return new NextResponse(exportResult.content, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${exportResult.fileName}"`,
    },
  });
}
