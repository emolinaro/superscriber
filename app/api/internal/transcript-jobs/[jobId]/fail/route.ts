import { NextResponse } from "next/server";
import { failTranscriptJob } from "@/server/orchestration/internal-queue";
import { requireOrchestrationAuthorization } from "@/server/orchestration/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// Stable failure classes are short lowercase slugs (e.g. "mel-shape-mismatch")
// the user can quote back to an operator; anything else is ignored so a
// worker cannot smuggle prose or markup into reviewer surfaces.
function parseErrorClass(value: unknown) {
  const slug = parseString(value);
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? slug : null;
}

function parseTechnicalDetail(value: unknown) {
  const detail = parseString(value);
  return detail ? detail.slice(0, 4_000) : null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const unauthorized = requireOrchestrationAuthorization(request);
  if (unauthorized) {
    return unauthorized;
  }

  const { jobId } = await context.params;

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const workerId = parseString(body.workerId);
    const detail = parseString(body.detail);

    if (!workerId || !detail) {
      return NextResponse.json(
        { ok: false, error: "workerId and detail are required." },
        { status: 400 },
      );
    }

    const retryable = typeof body.retryable === "boolean" ? body.retryable : undefined;
    const snapshot = failTranscriptJob({
      jobId,
      workerId,
      detail,
      retryable,
      errorClass: parseErrorClass(body.errorClass),
      technicalDetail: parseTechnicalDetail(body.technicalDetail),
    });

    return NextResponse.json({ ok: true, snapshot });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Job failure update failed.",
      },
      { status: 400 },
    );
  }
}
