import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { evaluatePolicy } from "@/domain/policy";
import { resolveCasefileAccess } from "@/server/access/service";
import { getAppDbBundle } from "@/server/db/client";
import { toRecording } from "@/server/db/mappers";
import { recordings, workspaces } from "@/server/db/schema";
import { getActivePrincipal } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ recordingId: string }>;

function parseRangeHeader(rangeHeader: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return null;
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end < start ||
    end >= size
  ) {
    return null;
  }

  return { start, end };
}

export async function GET(
  request: NextRequest,
  context: { params: Params },
) {
  try {
    const principal = await getActivePrincipal();
    if (!principal) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    const { recordingId } = await context.params;
    const bundle = getAppDbBundle();
    const recordingRow = bundle.db.select().from(recordings).where(eq(recordings.id, recordingId)).get();
    if (!recordingRow) {
      return new NextResponse("Not found", { status: 404 });
    }

    const recording = toRecording(recordingRow);
    const grant = resolveCasefileAccess(
      principal,
      recordingId,
      recording.currentRevisionId,
      bundle.db,
    );
    if (!grant) {
      return new NextResponse("This recording is not assigned to your account.", {
        status: 403,
      });
    }
    if (grant.kind === "uploader_status") {
      return new NextResponse(
        "Media playback is not available for this access grant.",
        { status: 403 },
      );
    }

    const workspace = bundle.db
      .select({ policyProfileId: workspaces.policyProfileId })
      .from(workspaces)
      .where(eq(workspaces.id, recording.workspaceId))
      .get();
    if (!workspace) {
      return new NextResponse("Not found", { status: 404 });
    }

    if (!evaluatePolicy(workspace.policyProfileId, principal.role).canViewMedia) {
      return new NextResponse(
        "This role cannot stream raw media in the current policy profile.",
        { status: 403 },
      );
    }

    if (!recording.mediaPath || !existsSync(recording.mediaPath)) {
      return new NextResponse("Media asset is not available for this recording.", {
        status: 404,
      });
    }

    const stats = statSync(recording.mediaPath);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-type": recording.mimeType ?? "application/octet-stream",
    });

    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, stats.size);
      if (!range) {
        return new NextResponse("Invalid range", {
          status: 416,
          headers: {
            "content-range": `bytes */${stats.size}`,
          },
        });
      }

      const stream = createReadStream(recording.mediaPath, {
        start: range.start,
        end: range.end,
      });
      headers.set("content-length", String(range.end - range.start + 1));
      headers.set("content-range", `bytes ${range.start}-${range.end}/${stats.size}`);

      return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers,
      });
    }

    headers.set("content-length", String(stats.size));
    const stream = createReadStream(recording.mediaPath);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers,
    });
  } catch {
    return new NextResponse("Media asset is not available for this recording.", {
      status: 500,
    });
  }
}
