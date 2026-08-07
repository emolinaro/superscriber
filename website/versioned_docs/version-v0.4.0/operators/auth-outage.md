# Authentik outage response

## What keeps working

- Existing local sessions (revocable session registry) continue until local
  expiry or revocation; governed work follows policy.
- Logout and administrator session revocation are purely local and keep working.
- Readiness (/api/health) stays up; the Authentication check reports the mode.

## What stops

- New OIDC sign-ins fail closed: discovery/JWKS failure produces a generic
  browser denial and a redacted `oidc.admission.denied` security event.
- Back-channel logout deliveries from the provider that fail signature
  validation are rejected; local sessions remain valid until they expire or
  are revoked locally.

## During the outage

1. Confirm scope: is this DNS/TLS to the issuer, or Authentik itself?
2. Communicate to users that active sessions continue; avoid mass logouts.
3. If emergency administration is required, use the break-glass path
   (`break-glass.md`) from the management boundary.
4. Do not widen clock tolerance, algorithms, or issuer matching to "work
   around" the outage. Drift is an operational fault.

## Recovery checks

1. New OIDC sign-in succeeds for a linked test user.
2. `GET /api/admin/auth-health` shows `oidcAdmission24h.allowed` increasing and
   no unexpected `denied` spike.
3. Review `security_events` for the outage window:

```bash
sqlite3 /path/to/superscriber.db \
  "select type, outcome, count(*) from security_events group by 1, 2 order by 3 desc;"
```
