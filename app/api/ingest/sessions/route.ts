import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createResumableUploadSession } from "@/server/ingest/service";
import { getActivePrincipal } from "@/server/session";

function parseString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parseNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const principal = await getActivePrincipal();
    if (!principal) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    if (principal.role !== "uploader" && principal.role !== "admin") {
      return NextResponse.json(
        { ok: false, error: "Only uploader and admin accounts can create ingest sessions." },
        { status: 403 },
      );
    }

    const body = (await request.json()) as Record<string, unknown>;
    const fileSize = parseNumber(body.fileSize);
    if (!fileSize || fileSize <= 0) {
      return NextResponse.json(
        { ok: false, error: "A positive file size is required." },
        { status: 400 },
      );
    }

    const status = createResumableUploadSession({
      title: parseString(body.title),
      languageHint: parseString(body.languageHint) || "english",
      source: parseString(body.source) === "record" ? "record" : "upload",
      role: principal.role,
      fileName: parseString(body.fileName),
      mimeType: parseString(body.mimeType) || null,
      fileSize,
    });

    revalidatePath("/workspace");

    return NextResponse.json({ ok: true, status });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "The ingest session could not be created.",
      },
      { status: 400 },
    );
  }
}
