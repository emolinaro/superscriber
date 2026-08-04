import { hashSync } from "bcryptjs";
import type { Page } from "@playwright/test";
import { withRuntimeDb } from "./appliance";
import { E2E_OIDC_ISSUER } from "./fake-oidc";

export const OIDC_ENABLED = Boolean(process.env.SUPERSCRIBER_E2E_OIDC?.trim());
export const RUNNING_IN_CONTAINER = Boolean(process.env.SUPERSCRIBER_E2E_CONTAINER_NAME?.trim());

/**
 * Seeds a local user plus an exact (issuer, subject) identity link directly in
 * the runtime database. Local-only harness: slice 3's fake OIDC provider is
 * hosted by the Playwright process on 127.0.0.1, which a container cannot
 * reach; the container harness lands in slice 8.
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
  const userId = withRuntimeDb((db) => {
    const existing = db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get(input.email) as { id: string } | undefined;

    const resolvedId = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      db.prepare(
        `INSERT INTO users (id, email, display_name, password_hash, role, is_active, auth_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      ).run(
        resolvedId,
        input.email,
        input.displayName,
        input.password ? hashSync(input.password, 12) : null,
        input.role,
        now,
        now,
      );
    }

    const existingLink = db
      .prepare(`SELECT id FROM external_identities WHERE issuer = ? AND subject = ?`)
      .get(E2E_OIDC_ISSUER, input.subject) as { id: string } | undefined;
    if (!existingLink) {
      db.prepare(
        `INSERT INTO external_identities (id, user_id, issuer, subject, status, linked_at, change_reason)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        crypto.randomUUID(),
        resolvedId,
        E2E_OIDC_ISSUER,
        input.subject,
        now,
        "E2E seeded link.",
      );
    }

    return resolvedId;
  });

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
      callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3105"}/?returnTo=/workspace`,
      json: "true",
    },
  });
  const body = (await response.json()) as { url?: string };
  if (!body.url) {
    throw new Error(`OIDC signin initiation failed: ${JSON.stringify(body)}`);
  }

  await page.goto(body.url);
}
