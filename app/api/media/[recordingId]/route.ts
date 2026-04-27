import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { resolveMedia } from "@/server/repository";
import { getActiveRole } from "@/server/session";

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
  const role = await getActiveRole();
  if (!role) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { recordingId } = await context.params;
  const media = resolveMedia(recordingId, role);
  if (!media) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (media.denied) {
    return new NextResponse(media.reason, { status: 403 });
  }
  if (media.missing) {
    return new NextResponse("Media asset is not available for this recording.", {
      status: 404,
    });
  }

  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type": media.mimeType,
  });

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const range = parseRangeHeader(rangeHeader, media.size);
    if (!range) {
      return new NextResponse("Invalid range", {
        status: 416,
        headers: {
          "content-range": `bytes */${media.size}`,
        },
      });
    }

    const stream = createReadStream(media.path, {
      start: range.start,
      end: range.end,
    });
    headers.set("content-length", String(range.end - range.start + 1));
    headers.set("content-range", `bytes ${range.start}-${range.end}/${media.size}`);

    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers,
    });
  }

  headers.set("content-length", String(media.size));
  const stream = createReadStream(media.path);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers,
  });
}
