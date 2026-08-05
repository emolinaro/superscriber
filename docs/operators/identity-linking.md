# Identity linking runbook

A validated OIDC `(issuer, subject)` pair links to exactly one existing local
`users.id`. Matching is byte-exact: no lowercasing, URL cleanup, slash removal,
email lookup, or username lookup. Email is never an identity key.

## Governance

Two-person identity governance reviews the mapping before apply. The mapping
file contains only local user ids, exact issuer, exact subject, and a change
reason - it must never contain email addresses.

```json
[
  {
    "userId": "existing-local-id",
    "issuer": "https://auth.example.com/application/o/superscriber/",
    "subject": "exact-authentik-sub",
    "changeReason": "Onboarding window 2026-08, ticket IAM-4412",
    "expectedRole": "reviewer"
  }
]
```

## Dry run (read-only)

Reports missing users, duplicate pairs, existing active links, pairs reserved
by retired links, and per-user assignment/audit counts:

```bash
SUPERSCRIBER_DB_PATH=/path/to/superscriber.db \
  npm run identity:import -- --file mapping.json --dry-run
```

Exit code 0 means clean; 2 prints findings and changes nothing.

## Apply (transactional)

All-or-nothing; one redacted `identity.link.applied` security event per user:

```bash
SUPERSCRIBER_DB_PATH=/path/to/superscriber.db \
  npm run identity:import -- --file mapping.json --apply --linked-by <operator-user-id>
```

After apply, each user must complete one successful OIDC sign-in before local
credentials are considered migrated for them.

## Collisions and reservations

- A `(issuer, subject)` pair is reserved forever once used; retirement never
  frees it. Reuse is a separately approved forensic data repair, not a runbook
  operation.
- A user can hold at most one active link per issuer. Relinking (subject
  changed for the same human) is an explicit maintenance action that retires
  the old link and inserts the new one in one audited transaction.
- Changing the issuer is a new identity namespace: dry-run everything again.

## Offboarding

When Authentik disables or deletes the account, run the offboard step: revoke
all local sessions and set the local user inactive. Links and history stay;
login stays denied. Local user records are never deleted while identity,
assignment, revision, approval, action-session, or audit references exist -
use deactivation.

Verify the result in `/api/admin/auth-health` (`identityLinks.active` drops,
sessions for that user disappear).
