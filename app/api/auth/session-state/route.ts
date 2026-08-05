import { NextResponse } from "next/server";
import { getActiveSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * Lightweight liveness probe polled by the authenticated shell (plan section
 * 7.3): lets an open UI converge within seconds after a session is revoked or
 * expires. Returns no identity data, only a boolean.
 */
export async function GET() {
  const session = await getActiveSession();

  return NextResponse.json(
    { active: Boolean(session) },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
