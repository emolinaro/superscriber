import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import {
  authExpiredIngestFailure,
  createResumableUploadSession,
  describeIngestFailure,
  IngestError,
} from "@/server/ingest/service";
import { isModelProvisioned } from "@/server/models/catalog";
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
      const failure = authExpiredIngestFailure();
      return NextResponse.json(failure.body, { status: failure.status });
    }
    if (principal.role !== "uploader" && principal.role !== "admin") {
      const failure = describeIngestFailure(
        new IngestError(
          "ACCESS_DENIED",
          "Only uploader and admin accounts can create ingest sessions.",
        ),
      );
      return NextResponse.json(failure.body, { status: failure.status });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw new IngestError("VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const fileSize = parseNumber(body.fileSize);
    if (!fileSize || fileSize <= 0) {
      throw new IngestError("VALIDATION_ERROR", "A positive file size is required.", {
        fileSize: "A positive file size is required.",
      });
    }

    const requestedModel = parseString(body.transcriptModel) || null;
    // demo-model-tier-picker: availability is server-checked against actual
    // provisioned artifacts; unknown/unprovisioned tiers are refused.
    if (requestedModel && !isModelProvisioned(requestedModel)) {
      throw new IngestError(
        "VALIDATION_ERROR",
        `Transcription model '${requestedModel}' is not provisioned on this host.`,
        { transcriptModel: `Transcription model '${requestedModel}' is not provisioned on this host.` },
      );
    }

    const status = createResumableUploadSession({
      principal,
      title: parseString(body.title),
      languageHint: parseString(body.languageHint) || "english",
      source: parseString(body.source) === "record" ? "record" : "upload",
      fileName: parseString(body.fileName),
      mimeType: parseString(body.mimeType) || null,
      // demo-advanced-model-picker: explicit model stays attached to the
      // recording; absent = engine default.
      transcriptModel: parseString(body.transcriptModel) || null,
      fileSize,
    });

    revalidatePath("/workspace");

    return NextResponse.json({ ok: true, status });
  } catch (error) {
    const failure = describeIngestFailure(error);
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
