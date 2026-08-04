# Key and certificate rotation

## OIDC signing keys (Authentik side)

Superscriber validates ID tokens and back-channel logout tokens only against
the JWKS discovered from the exact configured issuer. The JWKS cache honors
normal cache behavior and refreshes exactly once per request on an unknown
`kid`, then fails closed.

Rotation procedure:

1. Where Authentik publishes old and new keys concurrently: prepublish the new
   key, rotate the signing key, verify login with both key ids, then retire the
   old key.
2. Where it cannot: use a documented maintenance window. New logins pause while
   the JWKS lacks the signing key; existing validated local sessions continue
   until local expiry or revocation.
3. Rehearse against the exact target before the first production rotation.
   Record the rehearsal per `break-glass.md`'s drill-record format.

Unknown keys, algorithm changes (anything but RS256), stale discovery, and TLS
failure fail new login closed and surface in `security_events` as denial
events with coarse reasons.

## TLS certificates

- The deployment pins certificate trust via `NODE_EXTRA_CA_CERTS` when a
  private CA signs the issuer hostname. Verification is never disabled.
- Before expiry: renew the certificate, redeploy the CA bundle if the chain
  changed, and verify a fresh OIDC login.

## Superscriber-side material

- Client secret: mounted file only. Rotate by replacing the file at
  `SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE` and restarting; then update Authentik.
- Local auth secret (`data/auth.secret`): rotating invalidates all session
  cookies (registry rows remain authoritative for revocation state). Rotate
  only under incident authority.
- Break-glass password, keys, and recovery codes: see `break-glass.md`.
