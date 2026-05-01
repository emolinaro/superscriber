import { NextResponse } from "next/server";
import { getResumableUploadSession } from "@/server/ingest/service";
import { getActivePrincipal } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ sessionId: string }>;

export async function GET(
  _request: Request,
  context: { params: Params },
) {
  const principal = await getActivePrincipal();
  if (!principal) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (principal.role !== "uploader" && principal.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const { sessionId } = await context.params;
    const status = getResumableUploadSession(sessionId);
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Upload session lookup failed.",
      },
      { status: 404 },
    );
  }
}
