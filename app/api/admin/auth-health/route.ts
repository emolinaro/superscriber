import { NextResponse } from "next/server";
import { getAuthHealthSummary } from "@/server/auth/auth-health";
import { getActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * Admin-only redacted auth-health summary for operators (plan slice 7).
 */
export async function GET() {
  const principal = await getActivePrincipal();
  if (!principal) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (principal.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return NextResponse.json(getAuthHealthSummary(), {
    headers: { "Cache-Control": "no-store" },
  });
}
