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

First designation (zero to one) via an operator with database access:

```bash
SUPERSCRIBER_DB_PATH=/path/to/superscriber.db \
  npm run break-glass:designate -- --user <admin-user-id> --reason "initial custodian"
```

While signed in as admin, the Administration > Accounts > Emergency access
panel also offers first designation.

Transfer to a different existing admin is atomic - the old account's local
password path is disabled and its sessions revoked before the pointer moves:

```bash
SUPERSCRIBER_DB_PATH=/path/to/superscriber.db \
  npm run break-glass:transfer -- --user <admin-user-id> --reason "custodian change"
```

There is never a second concurrent break-glass account.

## Enrolling keys and recovery codes

The designated custodian - in their own signed-in session - enrolls up to
four hardware security keys for the account from Administration > Accounts >
Emergency access (two custodians, separate keys, separate sessions). Other
admins see designation status and counts only: custody controls are hidden
and the server rejects enrollment or code actions from any session but the
custodian's. The same panel issues recovery codes once; store them sealed
under dual custody. The panel and the Authentication
readiness check both report enrolled key and unused code counts.

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
