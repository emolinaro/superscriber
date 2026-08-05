import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  E2E_OIDC_GROUPS,
  startFakeOidcServer,
} from "../../../../../e2e/support/fake-oidc";

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

describe("back-channel logout route", () => {
  let dir: string;
  let fake: Awaited<ReturnType<typeof startFakeOidcServer>>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-bc-"));
    fake = await startFakeOidcServer({ port: 0 });
    writeFileSync(join(dir, "client-secret"), "route-secret\n");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function configure(mode: "dual" | "local") {
    writeFileSync(
      join(dir, "role-map.json"),
      JSON.stringify({
        version: 1,
        issuer: fake.issuer,
        claim: "superscriber_role_group_ids",
        groups: E2E_OIDC_GROUPS,
      }),
    );
    vi.stubEnv("SUPERSCRIBER_DB_PATH", join(dir, "route.db"));
    vi.stubEnv("SUPERSCRIBER_AUTH_MODE", mode);
    vi.stubEnv("SUPERSCRIBER_OIDC_ISSUER", fake.issuer);
    vi.stubEnv("SUPERSCRIBER_OIDC_CLIENT_ID", "superscriber");
    vi.stubEnv("SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE", join(dir, "client-secret"));
    vi.stubEnv("SUPERSCRIBER_OIDC_ROLE_MAP_FILE", join(dir, "role-map.json"));
    vi.resetModules();
  }

  async function post(body: Record<string, string>) {
    const { POST } = await import("./route");
    return POST(
      new Request("http://localhost/api/auth/backchannel-logout/authentik", {
        method: "POST",
        body: new URLSearchParams(body).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
  }

  async function logoutToken(overrides: Record<string, unknown> = {}) {
    return fake.control.signLogoutToken({
      iss: fake.issuer,
      aud: "superscriber",
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
      events: { [LOGOUT_EVENT]: {} },
      sid: "sid-live",
      ...overrides,
    });
  }

  async function seedOidcSession() {
    const { openAppDatabase } = await import("@/server/db/client");
    const bundle = openAppDatabase(join(dir, "route.db"));
    const now = new Date().toISOString();
    bundle.sqlite
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, is_active, created_at, updated_at)
         VALUES ('user-bc', 'bc@example.com', 'BC', NULL, 'reviewer', 1, ?, ?)`,
      )
      .run(now, now);
    const { applyIdentityLink } = await import("@/server/auth/identity-links");
    const link = applyIdentityLink(
      { userId: "user-bc", issuer: fake.issuer, subject: "sub-bc", changeReason: "route test" },
      bundle.db,
    );
    const { createAuthSession } = await import("@/server/auth/session-registry");
    const session = createAuthSession(
      {
        userId: "user-bc",
        authSource: "authentik",
        providerSid: "sid-live",
        externalIdentityId: link.id,
      },
      bundle.db,
    );
    return { bundle, session };
  }

  it("returns 404 in local mode (endpoint not live without a provider)", async () => {
    await configure("local");
    const response = await post({ logout_token: await logoutToken() });
    expect(response.status).toBe(404);
  });

  it("rejects a missing or malformed logout token with no account detail", async () => {
    await configure("dual");

    expect((await post({})).status).toBe(400);
    const invalid = await post({ logout_token: "not-a-jwt" });
    expect(invalid.status).toBe(400);
    const body = await invalid.text();
    expect(body).not.toContain("sid-live");
    expect(body).not.toContain("user-bc");
  });

  it("revokes the matching provider sessions and dedupes replays", async () => {
    await configure("dual");
    const { bundle, session } = await seedOidcSession();

    const token = await logoutToken();
    const first = await post({ logout_token: token });
    expect(first.status).toBe(200);

    const after = bundle.sqlite
      .prepare(`SELECT status, revoked_reason AS reason FROM auth_sessions WHERE id = ?`)
      .get(session.id) as { status: string; reason: string };
    expect(after).toEqual({ status: "revoked", reason: "backchannel_logout" });

    // Same (issuer, jti) again: idempotent success, no re-revocation needed.
    const replay = await post({ logout_token: token });
    expect(replay.status).toBe(200);

    const replayRows = bundle.sqlite
      .prepare(`SELECT COUNT(*) AS count FROM oidc_logout_replays`)
      .get() as { count: number };
    expect(replayRows.count).toBe(1);

    const events = bundle.sqlite
      .prepare(
        `SELECT outcome, metadata FROM security_events WHERE type = 'oidc.backchannel_logout' ORDER BY created_at, id`,
      )
      .all() as Array<{ outcome: string; metadata: string }>;
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0].metadata).data).toMatchObject({ targeting: "sid", replayed: false, revoked: 1 });
    expect(JSON.parse(events[1].metadata).data).toMatchObject({ replayed: true, revoked: 0 });
  });

  it("revokes by subject through the identity link", async () => {
    await configure("dual");
    const { bundle, session } = await seedOidcSession();

    const response = await post({
      logout_token: await logoutToken({ sid: undefined, sub: "sub-bc" }),
    });
    expect(response.status).toBe(200);
    expect(
      bundle.sqlite
        .prepare(`SELECT status FROM auth_sessions WHERE id = ?`)
        .get(session.id),
    ).toEqual({ status: "revoked" });
  });

  it("fails closed on an invalid signature but still answers without account detail", async () => {
    await configure("dual");
    await seedOidcSession();

    const token = await logoutToken();
    const tampered = `${token.slice(0, -2)}${token.endsWith("AA") ? "AB" : "AA"}`;
    const response = await post({ logout_token: tampered });
    expect(response.status).toBe(400);

    const { openAppDatabase } = await import("@/server/db/client");
    const bundle = openAppDatabase(join(dir, "route.db"));
    const count = bundle.sqlite
      .prepare(`SELECT COUNT(*) AS count FROM auth_sessions WHERE status = 'revoked'`)
      .get() as { count: number };
    expect(count.count).toBe(0);
  });
});
