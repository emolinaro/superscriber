import { NextResponse } from "next/server";

import { users } from "@/server/db/schema";
import { getAppDb } from "@/server/db/client";
import { getActivePrincipal } from "@/server/session";
import { eq } from "drizzle-orm";

// Per-user appearance persistence. The boot copy lives in localStorage
// (applied pre-paint by the layout script); this route is the durable sync
// point - GET seeds fresh devices/tabs, POST persists a choice. Appearance
// is a personal preference, not a governed mutation: no security event is
// written for it, only the user row updates.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THEME_VALUES = new Set(["system", "light", "dark"]);

export async function GET() {
  const principal = await getActivePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "auth_expired" }, { status: 401 });
  }
  const row = getAppDb()
    .select({ themePreference: users.themePreference })
    .from(users)
    .where(eq(users.id, principal.userId))
    .get();
  return NextResponse.json(
    { themePreference: row?.themePreference ?? "system" },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const principal = await getActivePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "auth_expired" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const value =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).themePreference
      : undefined;
  if (typeof value !== "string" || !THEME_VALUES.has(value)) {
    return NextResponse.json({ error: "bad_theme" }, { status: 400 });
  }
  const theme = value as "system" | "light" | "dark";

  getAppDb()
    .update(users)
    .set({ themePreference: theme, updatedAt: new Date().toISOString() })
    .where(eq(users.id, principal.userId))
    .run();

  return NextResponse.json({ ok: true, themePreference: theme });
}
