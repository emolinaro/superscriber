# Authentik OIDC deployment and configuration

Audience: operators deploying Superscriber against the institution's Authentik
for normal sign-in. Mail is disabled (see `no-mail-profile.md`).

## Configuration surfaces

All values are server-only. Secrets arrive by mounted files, never source,
browser variables, or command-line arguments.

| Setting | Required in | Purpose |
|---|---|---|
| `SUPERSCRIBER_AUTH_MODE` | dual, authentik-primary | `local`, `dual`, or `authentik-primary` |
| `SUPERSCRIBER_OIDC_ISSUER` | dual, authentik-primary | Exact canonical issuer, ending in `/` |
| `SUPERSCRIBER_OIDC_CLIENT_ID` | dual, authentik-primary | Non-secret client identifier |
| `SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE` | dual, authentik-primary | Mounted file path holding only the client secret |
| `SUPERSCRIBER_OIDC_ROLE_MAP_FILE` | dual, authentik-primary | Mounted non-secret versioned JSON role map |
| `SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE` | authentik-primary | Mounted CIDR + trusted proxy policy (break-glass boundary) |
| `SUPERSCRIBER_DEPLOYMENT_PROFILE` | always (optional) | Only `no-mail` is valid |
| `NEXTAUTH_URL` | dual, authentik-primary | Exact canonical Superscriber HTTPS origin |

The role map file binds the four local roles to four distinct Authentik group
UUIDs and must name the same issuer byte-for-byte:

```json
{
  "version": 1,
  "issuer": "https://auth.example.com/application/o/superscriber/",
  "claim": "superscriber_role_group_ids",
  "groups": {
    "uploader": "<group-uuid>",
    "reviewer": "<group-uuid>",
    "approver": "<group-uuid>",
    "admin": "<group-uuid>"
  }
}
```

Superscriber caches the last successfully validated role map in memory. Later
request-path configuration loads check the file modification time and reload
only when it changes. A temporary stat or read failure, or an invalid
replacement after the first successful load, leaves the previous mapping
active; an unreadable or invalid file on first use remains a configuration
error. Publish a rotation with a new modification time, preferably by
atomically replacing the file, then use the verification steps below to
confirm the new mapping.

## Authentik-side setup

1. Create a confidential **OAuth2/OIDC provider**:
   - Authorization flow: authorization code only.
   - Redirect URI: exactly `https://<superscriber-origin>/api/auth/callback/authentik`.
     No regex or wildcard entries.
   - Signing: RS256 via a dedicated signing certificate.
2. Add a custom scope named `superscriber_roles` whose property mapping returns
   `{"superscriber_role_group_ids": ["<direct-group-uuid>"]}` from the user's
   **direct** group memberships only. Nested inheritance is out of scope.
3. Create the four role groups (one per local role). Membership in exactly one
   group is required; zero or multiple means denial by design.
4. Create the application with those scopes: `openid profile superscriber_roles`.
   Do not request or grant `email`, `offline_access`, or provider API scopes.
5. Record the issuer, client id; mount the client secret to
   `SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE` mode 0400, owned appropriately.

## Changing a linked account's role

Coordinate both systems deliberately. For an OIDC-linked account, change direct Authentik group membership first:

1. Remove the old direct role group and add the target direct role group. The identity must belong to exactly one configured role group.
2. Immediately open **Administration > Accounts** in Superscriber, choose the matching target role, enter the required reason, and select **Save role**.
3. Have the affected person sign in again. The Superscriber role save revokes all existing sessions, so no previous session remains usable.

The coordination window fails closed. If the Authentik claim and local Superscriber role do not match, institutional sign-in shows only the generic denial and records the redacted `role_mismatch` reason, described operationally as a role mismatch. Superscriber never rewrites the local role from an OIDC claim and never changes the identity link during a role save.

In `dual` mode, an account with a local credential may use that credential with the new Superscriber role while institutional membership is being coordinated. In `authentik-primary` mode, normal local credentials remain disabled; institutional sign-in is unavailable until the direct group and local role match, while the designated break-glass procedure remains separate.

## Verify

1. Open the appliance first-run or administration surface; the **Authentication**
   readiness check reports the active mode and primary-mode invariant state.
2. Administrators can call `GET /api/admin/auth-health` for the redacted
   summary (session counts by source, 24h OIDC admission outcomes, link counts,
   break-glass facts).
3. Denied sign-ins land on the sign-in surface with a generic message; the
   specific reason is in `security_events` (never with email or subject values):

```bash
sqlite3 /path/to/superscriber.db \
  "select type, outcome, created_at from security_events order by created_at desc limit 20;"
```

## Roll back

Set `SUPERSCRIBER_AUTH_MODE=local` and restart. Identity links persist; local
credentials resume for existing local users. See `auth-rollback.md` for the
full reversal checklist.
