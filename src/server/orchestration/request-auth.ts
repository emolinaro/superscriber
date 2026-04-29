import { NextResponse } from "next/server";
import { getOrchestrationConfig } from "@/server/orchestration/config";

export function requireOrchestrationAuthorization(request: Request) {
  const secret = getOrchestrationConfig().sharedSecret;
  if (!secret) {
    return null;
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${secret}`) {
    return null;
  }

  return new NextResponse("Unauthorized", { status: 401 });
}
