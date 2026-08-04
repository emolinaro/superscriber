import { NextResponse } from "next/server";
import { loadAuthConfig } from "@/server/auth/auth-config";
import {
  claimLogoutReplaySlot,
  createLogoutTokenValidator,
  recordBackchannelLogoutEvent,
  revokeProviderSessions,
} from "@/server/auth/oidc-logout";

export const dynamic = "force-dynamic";

/**
 * OIDC back-channel logout (plan section 6.4.4). Validates the signed logout
 * token, dedupes (issuer, jti), and revokes matching local provider sessions
 * idempotently. Responses never reveal whether an account or session exists.
 */
export async function POST(request: Request) {
  let config;
  try {
    config = loadAuthConfig();
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  if (config.mode === "local") {
    return new NextResponse(null, { status: 404 });
  }

  const form = await request.formData().catch(() => null);
  const token = form?.get("logout_token");
  if (!form || typeof token !== "string" || token.length === 0) {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const validate = createLogoutTokenValidator({
    issuer: config.oidc.issuer,
    clientId: config.oidc.clientId,
  });
  const result = await validate(token);
  if (!result.ok) {
    recordBackchannelLogoutEvent({
      outcome: "denied",
      detail: "Back-channel logout token rejected.",
      metadata: { reason: result.reason },
    });
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const fresh = claimLogoutReplaySlot(result.claims.iss, result.claims.jti);
  let revoked = 0;
  if (fresh) {
    const targeting = result.claims.sid
      ? { issuer: result.claims.iss, sid: result.claims.sid }
      : { issuer: result.claims.iss, sub: result.claims.sub! };
    revoked = revokeProviderSessions(targeting).revoked;
  }

  recordBackchannelLogoutEvent({
    outcome: "success",
    detail: "Back-channel logout processed.",
    metadata: {
      targeting: result.claims.sid ? "sid" : "sub",
      replayed: !fresh,
      revoked,
    },
  });

  return new NextResponse(null, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
