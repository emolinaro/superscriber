import { NextResponse } from "next/server";

import {
  listProvisioningStatus,
  ProvisioningError,
  startTierDownload,
} from "@/server/models/provisioning";
import { getActivePrincipal } from "@/server/session";

// model-tier-provisioning: the ingest picker's self-service install surface.
// Status is readable by any signed-in principal; starting a download is
// admin-only because it writes gigabytes to the appliance disk and fetches
// from the pinned huggingface.co sources. Network surface: nothing beyond
// those pinned URLs.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const principal = await getActivePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "auth_expired" }, { status: 401 });
  }
  return NextResponse.json(listProvisioningStatus(), {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const principal = await getActivePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "auth_expired" }, { status: 401 });
  }
  if (principal.role !== "admin") {
    return NextResponse.json(
      {
        error: "access_denied",
        message: "Only admin accounts can install transcription models.",
      },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "validation_error", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const tierId = typeof body.tierId === "string" ? body.tierId.trim() : "";
  if (!tierId) {
    return NextResponse.json(
      { error: "validation_error", message: "A model tier id is required." },
      { status: 400 },
    );
  }

  try {
    const status = startTierDownload(tierId);
    return NextResponse.json({ ok: true, status }, { status: 202 });
  } catch (error) {
    if (error instanceof ProvisioningError) {
      return NextResponse.json(
        { error: error.code, message: error.message, ...(error.details ?? {}) },
        { status: error.httpStatus },
      );
    }
    throw error;
  }
}
