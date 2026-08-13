# Administrator recovery on an unmanageable appliance

Superscriber normally creates the first administrator through first-run setup
and then closes self-service admission entirely. That leaves one dangerous
corner: **accounts survive, but no active administrator remains.** Supported
role changes refuse to demote the final active admin, and a designated
break-glass admin has additional database guards. The state can still result
from out-of-band changes to an undesignated admin or a partial restore that
brought back user rows without an active admin. In that state nobody can
provision accounts, reset passwords, or exercise any governed admin command -
the instance is unmanageable.

For this case the sign-up door on `/` surfaces an **Administrator recovery**
pane with a claim ceremony for a fresh, active administrator account.

## Anti-claim protection (why the token exists)

A public "claim the admin account" form would be an instance-takeover vector:
whoever reached an unmanageable appliance first - including anyone who
*caused* the unmanageable state - would own it. The claim is therefore gated
on a proof only a host operator can present:

- When the recovery pane renders, the appliance mints a single-use 128-bit claim
  token at `admin-claim.token` **next to the database file** (the
  `SUPERSCRIBER_DB_PATH` directory; container default `/app/data/`), with
  owner-only (`0600`) permissions.
- Only someone with shell access to the appliance host (or the container's
  data volume) can read that file. Anyone who can read files next to the
  SQLite database could already edit the database directly, so the token
  binds the ceremony to exactly the access level it protects; a network-only
  attacker cannot race the operator to the crown.
- The submitted proof is verified with a timing-safe digest comparison.
- Claim attempts are rate-limited (5 attempts per 15 minutes per client, one
  shared bucket when the client address is unverifiable) and audited to the
  security event stream (`admin.recovery_claim`, `success` / `denied`). The
  attempted token is never recorded.
- The token is **consumed on a successful claim** and state gates are
  re-checked inside the claim transaction, so a concurrent or replayed claim
  cannot mint a second admin.

Deliberate trade-off: the claim proof requires host file access. The
alternative - letting anyone who can reach the sign-up door claim admin - is
rejected as a takeover vector. If your operating model cannot give the
recovery operator shell access to the appliance host, treat a "no active
admin" alert as an incident requiring direct data-volume intervention, and
prefer preventive measures (a second admin, or the break-glass designation)
so recovery is never needed.

## When the pane does not appear

- Zero accounts on the appliance: first-run setup owns admission instead.
- An active administrator exists: the sign-up door shows the normal
  "no self-service sign-up" explanation.
- `SUPERSCRIBER_AUTH_MODE=authentik-primary`: a locally claimed admin could
  not sign in (institutional sign-in is primary and the local form is
  disabled), so the pane steers to the break-glass ceremony instead - see
  [`auth-outage.md`](./auth-outage.md) and [`break-glass.md`](./break-glass.md).

## Recovery procedure

1. Confirm the appliance is unmanageable: signing in fails for every admin
   you know, and `/` leads with the **Administrator recovery** pane on the
   Sign up door.
2. On the appliance host, read the claim token:

   ```sh
   cat "$(dirname "${SUPERSCRIBER_DB_PATH:-./data/superscriber.db}")/admin-claim.token"
   ```

   In the container deployment:

   ```sh
   docker exec --user node <container> cat /app/data/admin-claim.token
   ```

3. In the recovery pane, enter the new administrator's name, email, password,
   and matching password confirmation, then paste the token. Dashes and letter
   case do not matter.
4. Submit. On success the appliance signs the claim into the audit stream,
   consumes the token, and lands on the sign-in door with a completion
   notice; sign in with the new administrator.
5. Re-establish hygiene: review the surviving accounts under Administration >
   Accounts, provision replacement access where needed, and investigate how
   the appliance lost its last administrator before returning to service.
   Account reactivation is not exposed in the product UI.

## Rotating or withholding the proof

Delete `admin-claim.token` on the host to retire the current proof; the next
render of the recovery pane mints a fresh one. A successful claim deletes the
file. If an operator restores an active administrator out of band instead,
delete the leftover token manually; state checks prevent it from being used
while an active administrator exists, but the file is not cleaned up by that
out-of-band change.

## Failure signals

| Symptom | Meaning |
| --- | --- |
| "The claim token did not match the proof on the appliance host." | Wrong or stale token; re-read the file. Audited as `denied`. |
| "Too many administrator claim attempts." | Brute-force budget exhausted; wait 15 minutes. Audited as `denied` (rate limit). |
| "An account with that email already exists." | Pick a fresh email; the claim only creates new accounts. |
| "An active administrator already exists." | Someone beat you to the claim or an admin was reactivated; the pane has already flipped back. |
| "The recovery claim is unavailable..." | The token file could not be written; restore data-directory writability and reload. |
