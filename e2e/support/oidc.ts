import { hashSync } from "bcryptjs";
import type { Page } from "@playwright/test";
import { execRuntimeSql, queryRuntimeRows } from "./appliance";
import {
  E2E_OIDC_ISSUER,
  oidcControl,
  startFakeOidcServer,
  type OidcControl,
} from "./fake-oidc";

export const RUNNING_IN_CONTAINER = Boolean(process.env.SUPERSCRIBER_E2E_CONTAINER_NAME?.trim());

/**
 * Resolves the OIDC provider control client for the current hosting mode:
 * an in-process fake for the local harness, the container netns sidecar
 * (published at the same well-known host port) otherwise.
 */
export async function startOidcControl(): Promise<{
  control: OidcControl;
  close(): Promise<void>;
}> {
  if (RUNNING_IN_CONTAINER) {
    return { control: oidcControl(E2E_OIDC_ISSUER), close: async () => {} };
  }

  const handle = await startFakeOidcServer();
  return { control: handle.control, close: () => handle.close() };
}

/**
 * Seeds a local user plus an exact (issuer, subject) identity link directly in
 * the runtime database. Container-safe: writes execute inside the container
 * when the container harness is active.
 */
export function seedOidcLinkedUser(input: {
  email: string;
  displayName: string;
  role: "uploader" | "reviewer" | "approver" | "admin";
  subject: string;
  password?: string;
}) {
  const now = new Date().toISOString();

  // Idempotent across reruns that share one runtime database.
  const existing = queryRuntimeRows<{ id: string }>(`select id from users where email = ?`, [
    input.email,
  ]);
  const userId = existing[0]?.id ?? crypto.randomUUID();

  if (!existing[0]) {
    execRuntimeSql(
      `insert into users (id, email, display_name, password_hash, role, is_active, auth_version, created_at, updated_at)
       values (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [
        userId,
        input.email,
        input.displayName,
        input.password ? hashSync(input.password, 12) : "",
        input.role,
        now,
        now,
      ],
    );
    if (!input.password) {
      // password_hash must be NULL, not empty, for OIDC-only users.
      execRuntimeSql(`update users set password_hash = null where id = ?`, [userId]);
    }
  }

  const existingLink = queryRuntimeRows<{ id: string }>(
    `select id from external_identities where issuer = ? and subject = ?`,
    [E2E_OIDC_ISSUER, input.subject],
  );
  if (!existingLink[0]) {
    execRuntimeSql(
      `insert into external_identities (id, user_id, issuer, subject, status, linked_at, change_reason)
       values (?, ?, ?, ?, 'active', ?, ?)`,
      [crypto.randomUUID(), userId, E2E_OIDC_ISSUER, input.subject, now, "E2E seeded link."],
    );
  }

  return { userId };
}

/**
 * Drives the browser through the real Auth.js OAuth redirect chain:
 * POST the signin form (PKCE/state/nonce cookies land in the page context),
 * then navigate the returned provider authorization URL; the fake provider
 * 302s back to the app callback, which mints the session and redirects to
 * the post-login funnel.
 */
export async function oidcSignIn(page: Page) {
  await page.context().clearCookies();

  const csrfResponse = await page.request.get("/api/auth/csrf");
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const response = await page.request.post("/api/auth/signin/authentik?json=true", {
    form: {
      csrfToken,
      callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3105"}/?returnTo=/workspace`,
      json: "true",
    },
  });
  const body = (await response.json()) as { url?: string };
  if (!body.url) {
    throw new Error(`OIDC signin initiation failed: ${JSON.stringify(body)}`);
  }

  await page.goto(body.url);
}

export function authSessionOidcdRows(userId: string) {
  return queryRuntimeRows<{
    authSource: string;
    providerSid: string | null;
    identityId: string;
  }>(
    `select auth_sessions.auth_source as authSource, auth_sessions.provider_sid as providerSid,
            external_identities.id as identityId
     from auth_sessions
     join external_identities on external_identities.id = auth_sessions.external_identity_id
     where auth_sessions.user_id = ? order by auth_sessions.created_at desc`,
    [userId],
  );
}
