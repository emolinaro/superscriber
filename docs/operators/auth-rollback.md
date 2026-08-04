# Authentication rollback

Rollback is a mode-transition, not a data migration. Identity links, security
events, sessions, and all governed content survive every transition.

## authentik-primary -> dual

1. Set `SUPERSCRIBER_AUTH_MODE=dual`; restart the appliance.
2. Verify readiness: Authentication reports dual mode.
3. Existing OIDC sessions remain valid; local credentials resume for all local
   users with passwords.
4. Break-glass restrictions relax (credentials no longer designee-only); this
   is intended during an incident and must be recorded in the incident file.

## dual -> local

1. Set `SUPERSCRIBER_AUTH_MODE=local`; restart.
2. The Authentik provider is not registered; the sign-in surface shows local
   credentials only. Identity links persist unused.
3. Active OIDC-minted sessions stay valid until expiry; to end them
   immediately, revoke via the administrative session controls or rotate the
   user's auth version (suspension/reactivation ceremony).

## Emergency session revocation

Revoke every active session for a user (bumps `users.auth_version` and revokes
the session rows in one transaction; connected UIs converge within five
seconds):

```bash
SUPERSCRIBER_DB_PATH=/path/to/superscriber.db \
  npm run auth:revoke -- --user <user-id> --reason "Incident containment"
```

Suspending a user additionally blocks new sign-ins. There is no user deletion
path; governance references are always preserved.

## Provider-side reversal

If the rollback follows an incident inside Authentik (misconfigured mapping,
compromised group admin), also revert the `superscriber_roles` property mapping
and re-export group membership for review before re-enabling dual.
