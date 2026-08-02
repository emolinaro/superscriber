import { basename } from "node:path";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { evaluatePolicy } from "@/domain/policy";
import { parseApprovedTranscriptExportFormat } from "@/lib/approved-transcript-export";
import { actorContextForPrincipal, insertAuditEvent } from "@/server/casefile/audit";
import { resolveActorContext } from "@/server/casefile/action-mode";
import { CasefileCommandError } from "@/server/casefile/errors";
import { resolveCasefileAccess } from "@/server/access/service";
import { getAppDbBundle } from "@/server/db/client";
import { toRecording, toRevision } from "@/server/db/mappers";
import { appStateMeta, recordings, revisions, workspaces } from "@/server/db/schema";
import { getActivePrincipal } from "@/server/session";
import { buildApprovedTranscriptExport } from "@/server/transcript-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ recordingId: string }>;

function toResponseBody(bytes: Uint8Array) {
  return new Blob([new Uint8Array(bytes)], {
    type: "application/octet-stream",
  });
}

function fileSafeName(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function approvedTranscriptExportBaseName(title: string) {
  return fileSafeName(title || "transcript").replace(/\.[^.]+$/, "") || "transcript";
}

function loadRecordingContext(recordingId: string) {
  const bundle = getAppDbBundle();
  const recordingRow = bundle.db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
  if (!recordingRow) {
    return null;
  }

  const workspaceRow = bundle.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, recordingRow.workspaceId))
    .get();
  if (!workspaceRow) {
    return null;
  }

  const recording = toRecording(recordingRow);
  const approvedRevision = recording.approvedRevisionId
    ? bundle.db.select().from(revisions).where(eq(revisions.id, recording.approvedRevisionId)).get()
    : null;

  return {
    bundle,
    recording,
    workspace: workspaceRow,
    approvedRevision: approvedRevision ? toRevision(approvedRevision) : null,
  };
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

  const rawActionModeId = searchParams.get("actionModeId");
  if (rawActionModeId !== null && !rawActionModeId.trim()) {
    return new NextResponse("Invalid admin action mode.", { status: 400 });
  }
  const actionModeId = rawActionModeId?.trim() || null;

  const { recordingId } = await context.params;
  const loaded = loadRecordingContext(recordingId);
  if (!loaded) {
    return new NextResponse("Not found", { status: 404 });
  }

  const grant = resolveCasefileAccess(
    principal,
    recordingId,
    loaded.recording.currentRevisionId,
    loaded.bundle.db,
  );
  if (!grant) {
    return new NextResponse("This recording is not assigned to your account.", {
      status: 403,
    });
  }
  if (grant.kind === "uploader_status") {
    return new NextResponse(
      "Approved transcript export is not available for this access grant.",
      { status: 403 },
    );
  }

  let actor = actorContextForPrincipal(principal);
  if (principal.role === "admin") {
    try {
      actor = resolveActorContext(
        principal,
        {
          recordingId,
          requiredEffectiveRole: "approver",
          actionModeId,
        },
        loaded.bundle.db,
      );
    } catch (error) {
      if (error instanceof CasefileCommandError) {
        return new NextResponse(error.message, { status: 403 });
      }
      return new NextResponse("Approved transcript export failed.", { status: 500 });
    }
  }

  const actorRole =
    actor.effectiveRole && actor.effectiveRole !== "system"
      ? actor.effectiveRole
      : principal.role;
  if (!evaluatePolicy(loaded.workspace.policyProfileId, actorRole).canDownloadApprovedTranscript) {
    return new NextResponse(
      "This role cannot export approved transcripts in the current policy profile.",
      { status: 403 },
    );
  }

  if (
    !loaded.approvedRevision ||
    loaded.approvedRevision.state !== "approved" ||
    loaded.recording.currentRevisionId !== loaded.approvedRevision.id
  ) {
    return new NextResponse("No approved transcript is available for export.", {
      status: 409,
    });
  }

  const payload = await buildApprovedTranscriptExport({
    format,
    recording: loaded.recording,
    revision: loaded.approvedRevision,
  }).catch(() => null);
  if (!payload) {
    return new NextResponse("Approved transcript export failed.", {
      status: 500,
    });
  }

  const issued = loaded.bundle.sqlite.transaction(() => {
    const now = new Date().toISOString();
    const currentRecording = loaded.bundle.db
      .select()
      .from(recordings)
      .where(eq(recordings.id, recordingId))
      .get();
    const currentRevision = loaded.bundle.db
      .select()
      .from(revisions)
      .where(eq(revisions.id, loaded.approvedRevision!.id))
      .get();
    if (
      !currentRecording ||
      !currentRevision ||
      currentRevision.state !== "approved" ||
      currentRecording.approvedRevisionId !== loaded.approvedRevision?.id ||
      currentRecording.currentRevisionId !== loaded.approvedRevision?.id
    ) {
      return false;
    }

    insertAuditEvent(loaded.bundle.db, {
      workspaceId: currentRecording.workspaceId,
      recordingId,
      actor,
      type: "export.issued",
      detail: `Approved transcript exported as ${format}.`,
      metadata: {
        expectedApprovedRevisionId: loaded.approvedRevision.id,
        format,
        actionModeId,
      },
      createdAt: now,
    });
    loaded.bundle.db
      .update(appStateMeta)
      .set({ stateVersion: sql`${appStateMeta.stateVersion} + 1` })
      .where(eq(appStateMeta.id, 1))
      .run();

    return true;
  })();

  if (!issued) {
    return new NextResponse("No approved transcript is available for export.", {
      status: 409,
    });
  }

  const safeBase = approvedTranscriptExportBaseName(loaded.recording.title);
  return new NextResponse(toResponseBody(payload.body), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": payload.contentType,
      "content-disposition": `attachment; filename="${safeBase}-approved-v${loaded.approvedRevision.version}.${format}"`,
    },
  });
}
