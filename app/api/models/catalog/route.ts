import { NextResponse } from "next/server";

import { getActivePrincipal } from "@/server/session";
import { listModelCatalog } from "@/server/models/catalog";

// demo-model-tier-picker: ingest's Advanced settings reads this - availability
// is computed server-side from actual model artifacts so the dropdown can
// never offer a tier the host cannot run.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const principal = await getActivePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "auth_expired" }, { status: 401 });
  }
  return NextResponse.json(listModelCatalog(), {
    headers: { "cache-control": "no-store" },
  });
}
