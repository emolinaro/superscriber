# OIDC integration acceptance report - 2026-08-04

Qualification stance: local-first. The pinned Authentik target has not been
contacted (explicitly out of scope via the dispatch contract); provider
behavior is qualified against the canonical signed-fake OIDC provider
(`e2e/support/fake-oidc.ts`, RS256 with real discovery/JWKS) hosted both
in-process and as a container network sidecar.

Evidence levels: unit (vitest), route (handler-level with real loopback HTTP),
e2e-local (Playwright, dual mode), e2e-container (`npm run e2e:container`,
dual mode with sidecar).

## Section 16 acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Exact issuer, code flow, PKCE S256, state, nonce, RS256, aud/exp validation | PASS | authentik-provider.ts construction tests; options-dual; e2e OIDC happy path (container + local) |
| 2 | No email/API/offline_access scopes | PASS | provider scope assertion (exact "openid profile superscriber_roles") |
| 3 | Exact pair resolves to intended users.id; email renames indifferent | PASS | identity-links tests incl. rename indifference; e2e principal equivalence |
| 4 | Unknown/retired/colliding/zero/multi/malformed/role-mismatch denied generically | PASS | oidc-admission matrix; role-mapping matrix; e2e unlinked + zero-group + cancel deny with one generic message and no enumeration |
| 5 | Assignments/capabilities/revisions/decisions/audit attribution unchanged | PASS | slice-0 contract inventory; full governed-casefile e2e (container) unmodified |
| 6 | Suspension/role change/revoke effective next request; UI converges ≤5s | PASS | session-registry tests; e2e revocation specs (poll-driven convergence, server denial) |
| 7 | Fail closed when local auth state unreadable | PASS | registry "unavailable" test; options callback fail-closed tests |
| 8 | No secrets/tokens/claims/membership in session JSON, logs, audit, screenshots | PASS | e2e session-JSON assertions (no subject/group ids); security-event redaction tests; metadata key blocklist |
| 9 | Logout revokes before cookie clear | PASS | e2e sign-out spec (revoked_reason=logout observed) |
| 10 | Back-channel termination via validated replay-safe channel | PASS | oidc-logout negative matrix; route integration (signature, iss/aud/iat/events, dedupe); e2e back-channel revocation + convergence |
| 11 | Exactly one Credentials principal in target mode, management boundary + password + WebAuthn | PASS | primary-mode authorize gate; management-zone-gated disclosure; options-breakglass ceremony test; emergency-access denial matrix (zone, lockout, replay) |
| 12 | Break-glass 2 keys, dual custody, rehearsal, 15/5-min bounds, banner | PASS | two-custodian enrollment e2e with virtual authenticators; one-time recovery codes; session bounds in registry tests; banner e2e |
| 13 | Break-glass cannot bypass action mode/self-approval | PASS | break-glass principal is plain base admin; governed regression suite unmodified and green |
| 14 | All four roles equal their local principal equivalents | PASS | role mapping one-role accepts per role; e2e reviewer equivalence; admin/uploader/approver mirror via admission unit tests |
| 15 | Migration/rollback preserve ids and reference counts | PASS | slice-0 contract; upgrade-rehearsal staging test (v2→v6, backup restore, FK check) |
| 16 | Discovery/JWKS outage blocks only new login | PASS | validator fail-closed tests; outage runbook; existing sessions validated locally |

## Runs at this commit

- npm test: 465 unit/integration tests green
- npm run typecheck: clean
- npm run build: clean
- npm run e2e (local, dual mode): 21/21 green (includes the break-glass ceremony)
- npm run e2e:container (dual mode, OIDC sidecar): 21/21 green

## Dependency decision

webauthn-dependency resolved by the captain on 2026-08-03: only
@simplewebauthn/server@13.3.2 (pinned, server side); the browser ceremony is
hand-rolled with navigator.credentials; no browser-side library.
