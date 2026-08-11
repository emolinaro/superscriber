import { desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

import { resolveCasefileAccess } from "@/server/access/service";
import { getAppDb } from "@/server/db/client";
import { recordings, transcriptJobs } from "@/server/db/schema";
import { getActivePrincipal } from "@/server/session";

// Live transcription progress (work-list lane): one light batch payload per
// poll cycle. The response carries the latest job per requested recording so
// the caller can retire a row's progress surface as soon as the job leaves
// the in-flight states (the governed stage labels refresh with the usual
// router refresh).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const principal = await getActivePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "auth_expired" }, { status: 401 });
  }

  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids")?.trim() ?? "";
  const ids = idsParam
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 50);

  if (ids.length === 0) {
    return NextResponse.json({ jobs: [] }, { headers: { "cache-control": "no-store" } });
  }

  const db = getAppDb();
  const jobRows = db
    .select({
      id: transcriptJobs.id,
      recordingId: transcriptJobs.recordingId,
      state: transcriptJobs.state,
      progressPercent: transcriptJobs.progressPercent,
      transcribedUntilMs: transcriptJobs.transcribedUntilMs,
      audioDurationMs: transcriptJobs.audioDurationMs,
      segmentsSeen: transcriptJobs.segmentsSeen,
      updatedAt: transcriptJobs.updatedAt,
    })
    .from(transcriptJobs)
    .where(inArray(transcriptJobs.recordingId, ids))
    .orderBy(desc(transcriptJobs.updatedAt))
    .all();

  const latestByRecording = new Map<string, (typeof jobRows)[number]>();
  for (const row of jobRows) {
    if (!latestByRecording.has(row.recordingId)) {
      latestByRecording.set(row.recordingId, row);
    }
  }

  // Access gate: an id is only reported when the caller holds a casefile
  // grant for it - the batch route never weakens per-recording access rules.
  const valid = ids.filter((id) => {
    const row = db.select().from(recordings).where(eq(recordings.id, id)).get();
    if (!row) {
      return false;
    }
    return Boolean(resolveCasefileAccess(principal, id, row.currentRevisionId, db));
  });

  return NextResponse.json(
    {
      jobs: valid
        .map((id) => latestByRecording.get(id))
        .filter((row) => row != null)
        .map((row) => ({
          recordingId: row.recordingId,
          state: row.state,
          progressPercent: row.progressPercent,
          transcribedUntilMs: row.transcribedUntilMs,
          audioDurationMs: row.audioDurationMs,
          segmentsSeen: row.segmentsSeen,
          updatedAt: row.updatedAt,
        })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
