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
