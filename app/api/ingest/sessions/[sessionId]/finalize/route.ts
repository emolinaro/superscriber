import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { finalizeResumableUploadSession } from "@/server/ingest/service";
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
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (principal.role !== "uploader" && principal.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const { sessionId } = await context.params;
    const status = await finalizeResumableUploadSession(sessionId);
    revalidatePath("/workspace");
    revalidatePath(`/recordings/${status.recordingId}`);
    return NextResponse.json({
      ok: true,
      status,
      nextPath:
        principal.role === "admin" ? `/recordings/${status.recordingId}` : "/workspace",
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Upload finalization failed.",
      },
      { status: 409 },
    );
  }
}
