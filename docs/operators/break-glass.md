# Break-glass emergency access

The break-glass account is the single local administrator usable in
`authentik-primary` mode, intended only for IdP-outage or governance incidents.
It remains a normal `admin` principal: governed work stays read-only until the
existing record-bound action mode is entered, and it cannot approve its own
submission.

## Controls in force

- Exactly one designated user (`auth_control` singleton; trigger-enforced).
- Password plus WebAuthn hardware key (two enrolled keys, separate custodians).
- Reachable only through the management boundary
  (`SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE`); anything unverifiable fails closed.
- Sessions: 15-minute absolute, 5-minute idle; a persistent emergency banner
  shows the activation correlation id, reason, and expiry.
- An incident reason of 10-500 characters is recorded per activation.
- Recovery codes: single-use, stored only as hashes, sealed copies split under
  dual custody; rotate the full set after any use or exposure.

## Designation and transfer

Designation is part of deployment provisioning. Transfer to a different
existing admin is atomic: the old account's local password path is disabled and
its sessions revoked before the pointer moves. There is never a second
concurrent break-glass account.

## Rotation cadence

Rotate the password and verify both hardware keys at least every 90 days, and
immediately after emergency use, personnel change, suspected disclosure, or a
rehearsal failure.

## Rehearsal (quarterly, IdP-outage simulation)

Record each rehearsal with this format (no credential material):

```text
date_utc: <YYYY-MM-DD>
custodian_roles: [security officer, records administrator]
result: pass | fail
session_id: <correlation id from the emergency banner or security_events>
corrective_action: <required follow-up or "none">
```

Store the record per institutional retention policy. The emergency banner's
correlation id is the join key to `security_events` for the attempt/outcome
trail.

## Unavailable-account procedure

1. One hardware key unavailable: use the second key.
2. Both unavailable: dual custodians use one recovery code with the password on
   the local management console, then immediately enroll replacement keys and
   rotate all secrets.
3. Profile damaged: the offline console recovery command may repair credentials
   for the same `users.id`.
4. Database or user row unavailable: restore the tested application backup.
   Authentication must not bypass database readiness.
