import { NextResponse } from "next/server";
import { getAppDbBundle } from "@/server/db/client";
import { getOrchestrationConfig } from "@/server/orchestration/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const bundle = getAppDbBundle();
  bundle.sqlite.prepare("SELECT 1").get();

  const config = getOrchestrationConfig();

  return NextResponse.json({
    ok: true,
    mode: config.mode,
    workerExpected: config.mode === "internal",
    timestamp: new Date().toISOString(),
  });
}
