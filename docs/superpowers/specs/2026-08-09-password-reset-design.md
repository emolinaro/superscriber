# Superscriber Password Reset Design

**Date:** 2026-08-09

**Status:** Written-design review gate

**Scope:** Two flows, one specification:

1. Email-based self-service password reset for local accounts.
2. Administrator manual password reset for every account, with deliberate precedence over any in-flight self-service flow.

## 1. Product contract

- A signed-out user who has a working local credential can request a reset from the sign-in surface. The response is always identical whether or not the email matches an account, so the flow cannot be used to enumerate accounts.
- When the operator has explicitly configured reset mail, a single-use reset link is emailed. When reset mail is not configured (the default `no-mail` posture), no mail is sent and the reset proceeds only through the operator-assisted path: an administrator issues the link and hands it over out-of-band.
- An administrator can reset any active account's password. Admin issuance immediately retires every session of the target from every auth source, invalidates all outstanding reset tokens for that account (including self-service ones), and produces exactly one new single-use link disclosed through exactly one channel.
- A successful reset - by either flow - writes the new password hash, advances `users.auth_version`, revokes every active session of the user across local, Authentik, and break-glass auth sources, and consumes the token. The user is not auto-signed in; they sign in fresh with the new password.
- The designated break-glass account cannot be reset through either flow. Its password rotates only through the existing emergency ceremony (`rotateBreakGlassPassword`), and lockout of the designee is resolved through break-glass recovery codes.
- Phone safety mode stays inspection-only: no reset mutation controls render on phones, on any surface.
- Password change (signed-in user rotating their own known password), account deactivation, notification mail, and any other mail use are outside this ship.

## 2. Current-state findings and governing invariants

### 2.1 Local credentials and accounts

- `src/server/auth/service.ts` creates local users and verifies credentials with bcrypt cost 12 (`hash`/`compare` from bcryptjs). Password policy lives in `localUserSchema` (`src/server/auth/validation.ts`): 10-200 characters.
- `users.password_hash` is nullable since schema v4: OIDC-only shadow users carry no local secret. The break-glass transfer ceremony writes a `disabled:<random>` sentinel hash to permanently disable a local credential path (`src/server/auth/break-glass.ts`); verification rejects any hash with the `disabled:` prefix.
- An account therefore falls into one of three credential states: usable local credential, `disabled:` sentinel, or `NULL`. Self-service reset may only ever serve the first state (section 4.3); admin reset may deliberately install or restore a credential (section 5).

### 2.2 Sessions, auth_version, and revocation

- `users.auth_version` starts at 1. Every durable session row in `auth_sessions` pins the issuing `auth_version` and one of `AUTH_SOURCES` (`local`, `authentik`, `break_glass`).
- `validateAuthSession` in `src/server/auth/session-registry.ts` checks the durable row on every protected session read; a version mismatch revokes the row with `auth_version_changed` and emits `auth.session.revoked`.
- `retireUserSessions({ userId, reason })` bumps `auth_version` and revokes every active session row for the user in one transaction, recording one `auth.session.revoked` security event per session. This is the existing, proven revocation primitive (used by suspension, role change, identity retirement, password rotation, break-glass transfer) and both reset flows build on it rather than introducing a parallel mechanism.
- The upstream Authentik SSO session is outside this deployment's data plane. Revoking registry rows forces re-admission through OIDC; if the upstream SSO session is still alive, Authentik may silently re-admit the user. This matches the accepted behavior of the account-role guards merged at f7816ef and is not changed by this design.

### 2.3 Auth modes and Authentik-linked identities

- `AUTH_MODES` (`src/server/auth/auth-config.ts`): `local` (credentials only), `dual` (credentials plus OIDC for linked users), `authentik-primary` (OIDC normal; plain password credentials admit nobody - not even the break-glass designee). The suppression guard lives in `src/server/auth/options.ts` and must remain untouched: completing a reset never mints a session and never re-enables credential sign-in under `authentik-primary`.
- `external_identities` links local users to Authentik issuer/subject pairs. Identity retirement already advances `auth_version` and retires sessions ("auth.legacy_sessions_invalidated" precedent in `identity-links.ts`).

### 2.4 Break-glass

- The `auth_control` singleton designates exactly one emergency local admin; database triggers enforce the invariants (no second designee, designee cannot be demoted, deactivated, or deleted). Service-level validation is in `src/server/auth/break-glass.ts`.
- Break-glass sessions carry shortened bounds (15 min absolute, 5 min idle) and the `break_glass` auth source. Emergency access rate limiting (5 failures lock 15 minutes, in-memory) lives in `src/server/auth/webauthn.ts`.
- `rotateBreakGlassPassword` is the designee's existing password rotation path and emits `breakglass.password_rotated`.

### 2.5 Administration and governance

- The account-role management flow merged at f7816ef (`src/server/administration/account-role-service.ts`) establishes the pattern this design follows: a server-enforced governed mutation with `validateGovernedReason` (`src/domain/casefile.ts`), a governance audit event via `insertAuditEvent` with `actorContextForPrincipal` (`src/server/casefile/audit.ts`), a redacted security event, atomic `auth_version` advancement plus session retirement, and final-admin protection for role changes. Role guards and triggers stay authoritative on the server; the client is guidance, not an authority boundary.
- Final-admin protection concerns roles, not credentials: a password reset never changes a role, so no additional final-admin rule is needed beyond the denial of break-glass resets (section 5.4).
- Security events are typed, outcome-bearing rows (`security_events` table; `recordSecurityEvent` in `src/server/auth/security-events.ts`) with outcomes `success` | `denied` | `error`. Existing types include `auth.session.revoked`, `breakglass.password_rotated`, and `account.role_changed`.

### 2.6 No-mail posture

- `docs/operators/no-mail-profile.md` documents that mail is disabled by design: no SMTP integration, no transactional mail, no notification surface, no email-based identity matching. `SUPERSCRIBER_DEPLOYMENT_PROFILE=no-mail` is the only valid value; anything else blocks the `deployment_profile` readiness check (`src/server/bootstrap/readiness.ts`).
- The captain has deliberately changed this posture **for the password-reset path only**. This design scopes the minimal seam in section 3.

### 2.7 Phone safety mode

- `src/components/ui/phone-safety.tsx` classifies the client (width < 768, or coarse pointer with height < 768) and the hook initializes to safe mode before classification so mutation controls never flash during hydration. The administration shell omits mutation controls while leaving facts visible; the Accounts section already follows this pattern for creation and role editing. The one-time reset-link reveal and issuance controls follow the same rule (section 7).

## 3. The reset-mail seam (minimal, opt-in, honest when absent)

The deployment profile remains `no-mail`. The reset path gains a deliberately narrow, independently gated mail seam:

- **Configuration surface (new):** `SUPERSCRIBER_RESET_MAIL_MODE` accepts unset or `none` (default) or `smtp`. Anything else blocks readiness. When `smtp`, the operator must also supply `SUPERSCRIBER_RESET_MAIL_SMTP_HOST`, `_PORT`, `_FROM_ADDRESS`, and `SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE` (mounted secret file, consistent with the OIDC client-secret-file pattern; the loader reads the path, never inline secrets). `SUPERSCRIBER_RESET_MAIL_BASE_URL` sets the public origin used to build reset links; absent it falls back to the request origin. SMTP is the only transport in this ship: a single seam over operator-hosted submission, with no SaaS dependency and no templating engine.
- **Content constraint:** the seam can send exactly one transactional template: the reset URL, its absolute expiry, and a line directing the recipient to their administrator. It carries no transcripts, notifications, case data, or any other content, and no other code path is given a handle to the mailer. The mailer module accepts the template identifier and a recipient address, nothing else.
- **Absent by default:** with the seam unconfigured, no socket, dependency, or code path can send mail. Self-service requests still return the identical anti-enumeration response (section 4.4) and simply do not send; the response copy points the requester at their administrator, and the admin flow (section 5) is the working recovery path.
- **Honest degradation:** a new readiness check `reset_mail` reports one of two ready states - "not configured: resets are operator-assisted" or "configured (smtp)" - and a blocked state only for malformed configuration. A delivery failure at send time never changes the requester's response; it records `password.reset.mail_failed` (outcome `error`) so the failure is visible to administrators on the security-event surface instead of being silently swallowed.
- **Docs:** implementation updates `docs/operators/no-mail-profile.md` to describe the scoped exception, the configuration surface, and the amended "no mail surfaces" verification grep (which must exclude the reset-mailer module).

## 4. Self-service password reset

### 4.1 Reset token mechanics

New table `password_reset_tokens` (schema v9):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text, primary key | UUID |
| `user_id` | text, FK `users.id` | `onDelete: "restrict"`, indexed |
| `token_hash` | text, unique index | SHA-256 hex of the token; the raw token is never stored |
| `source` | text enum | `self_service` \| `admin` |
| `delivery` | text enum | `email` \| `operator_handoff` |
| `requested_by_user_id` | text, nullable FK `users.id` | admin actor for admin-issued tokens; NULL for self-service |
| `created_at` / `expires_at` | text | TTL 60 minutes |
| `used_at` | text, nullable | set atomically at completion |
| `invalidated_at` / `invalidated_reason` | text, nullable | `superseded` \| `admin_precedence` \| `user_reset_completed` |

- **Generation and storage:** the token is 32 bytes from `crypto.randomBytes`, base64url-encoded (256 bits of entropy). Only its SHA-256 digest is stored. SHA-256 is sufficient here because the token is high-entropy random, not a human password; bcrypt adds no value against offline guessing of a 256-bit secret, and lookup by digest keeps verification constant-shape. Verification is a digest lookup plus expiry/state checks, with no per-byte comparison of attacker input against a stored secret in application code.
- **TTL:** 60 minutes from issuance for both flows. Justification: long enough for mail latency and an administrator walking a link to a user, short enough to bound the exposure of a leaked link.
- **Single-use:** completion sets `used_at` inside the same transaction that writes the new password hash; a token that is used, expired, or invalidated is rejected with the same generic failure copy.
- **Invalidation of prior tokens:** issuing any new token for a user invalidates all of that user's outstanding tokens (`superseded`, or `admin_precedence` when an admin issuance supersedes self-service tokens). The newest token is the only live one.
- **Completion effects:** one transaction - insert nothing elsewhere - that (1) marks the token used, (2) writes the new bcrypt(12) hash, (3) calls `retireUserSessions({ userId, reason: "password_reset" })` which advances `auth_version` and revokes every active session across all auth sources, and (4) invalidates any remaining tokens (`user_reset_completed`).
- **Request alone changes nothing:** a self-service request never advances `auth_version`, never revokes sessions, and never touches the password hash. Otherwise anonymous visitors could log arbitrary users out at will, and the request would observable-differ between known and unknown emails.
- **Link format:** `GET /reset/<token>` renders an unauthenticated completion form (new password + confirmation, validated by the same 10-200 character policy). The form posts to a server action carrying the token; the token in the URL is the sole capability, so no additional bearer is introduced. Completion never auto-signs-in: the user sees a success page with a sign-in link.

### 4.2 Offer and entry points

- The "Forgot password" affordance appears on the sign-in surface only when the credential form is offered: auth modes `local` and `dual`. In `authentik-primary`, plain credentials admit nobody, so no self-service reset affordance is rendered and the request route is not linked; if reached directly, it returns the same generic response without creating tokens. Local credential suppression stays intact.

### 4.3 Eligible accounts

Self-service creates a token only for accounts that can actually authenticate with a password: active, `password_hash` present, and not carrying the `disabled:` sentinel. OIDC-only shadow users, disabled-credential accounts, and inactive accounts are treated exactly like unknown emails (section 4.4). Allowing reset to install a credential on an OIDC-only account would let mailbox control mint a persistent local credential and widen the auth surface without an operator decision; the deliberate version of that act belongs to the admin flow.

### 4.4 Anti-enumeration behavior

- The response body and status are byte-identical for known and unknown emails: "If an account matches that email, a password reset has been started. If nothing arrives, contact your administrator." This copy is true in both mail states: with mail configured a link may arrive; without it, administrator contact is precisely the next step.
- Constant-shape work: for unknown or ineligible emails the handler performs a dummy bcrypt compare (matching the cost of a real verification) so timing does not distinguish account existence.
- Rate limits (section 6) apply identically to known and unknown emails, so limits never leak existence either.
- Server-side, the request is recorded as `password.reset.requested` with outcome `success` (eligible request accepted) or `denied` (unknown, inactive, no local credential, rate limited) so incident responders keep visibility that the requester never gets. When the mail seam is unconfigured, an accepted request creates no token and sends nothing (section 4.5); the event metadata records `delivery: "unconfigured"` so responders can tell accepted-and-sent apart from accepted-but-operator-assisted. The event detail and metadata never contain the submitted email address; eligible events key off `userId`, ineligible ones carry only the denial reason.

### 4.5 Mail unconfigured: operator-assisted path (decision)

When the seam is unconfigured the self-service request still answers identically and still creates no externally visible difference; token issuance is skipped. The working recovery path is the admin flow in section 5. We propose this over a hard "reset unavailable" blocked state because:

- In the default `no-mail` deployment, self-service can never deliver anything; a blocked self-service page would advertise a dead feature and, worse, its blocked/available toggle would itself become an enumeration oracle.
- Operator-assisted recovery is already the documented account-onboarding posture ("account onboarding is a local act", `no-mail-profile.md`); resets follow the same trust model.
- The identical response, including the "contact your administrator" instruction, preserves anti-enumeration while still telling a legitimate user exactly what to do.

## 5. Administrator manual reset

### 5.1 Contract

- From Administration > Accounts, an administrator with a live admin principal invokes **Reset password** on any active account row, supplies a governed **reason** (validated by `validateGovernedReason`), and confirms.
- One governed transaction: (1) invalidates every outstanding reset token for the target (`admin_precedence` - this is the precedence over self-service), (2) calls `retireUserSessions({ userId, reason: "admin_password_reset" })`, immediately revoking all of the target's sessions across every auth source, (3) creates one new token (`source: "admin"`, 60-minute TTL, hashed at rest). Immediate retirement at issuance - unlike self-service, which revokes at completion - is the deliberate asymmetry: issuance is an auditable privileged act, typically incident-driven, and must sever possibly-compromised sessions at once rather than whenever the link happens to be used.
- Delivery is exactly one disclosure channel, chosen by the admin at issuance:
  - **Out-of-band handoff** (always available): the link is revealed exactly once in the admin UI with a copy affordance and the absolute expiry, then never displayed again. The admin delivers it by whatever channel they trust.
  - **Email** (only when the reset-mail seam is configured): the seam sends the single transactional template to the account's email address and the link is never displayed to the admin.
- A governance audit event `account.password_reset` (actor, target, reason) is written via `insertAuditEvent` with `actorContextForPrincipal`, and a redacted security event `admin.password_reset.issued` records actor, target, source/delivery, and the token's `id` - never the token itself.
- Targets must be active accounts. Resetting an inactive account is denied (the account cannot sign in regardless, and a live token on a dormant account is needless exposure).

### 5.2 Local-credential effects by credential state

Admin reset is deliberately stronger than self-service: it is the operator's recovery tool, and completing an admin-issued link writes a fresh local credential in any credential state:

- **Usable local credential:** replaced.
- **OIDC-only (`NULL`):** a local credential is installed. This is the sanctioned "Authentik-side lockout" recovery in `dual` mode; the audit event names the actor and reason.
- **`disabled:` sentinel (post-transfer break-glass accounts):** denied, with `admin.password_reset.issued` outcome `denied` and reason `credential_disabled`. Re-enabling a retired local path is a designation-ceremony decision, not a password-reset side effect.

Regardless of credential state, completion must not mint a session, must not alter `external_identities`, and must not weaken the `authentik-primary` suppression guard: under that mode a reset local credential still signs nobody in until an operator changes the auth mode, exactly as today for any stored credential.

### 5.3 Admin resetting themselves

Allowed, with an explicit UI warning that their own session ends immediately. Issuance retires their sessions like any target's; they complete the reset with the link they were just shown (out-of-band) or received (email). There is no self-service exemption that would create a second, weaker policy surface for admins.

### 5.4 Break-glass account

Both flows deny resets of the designated break-glass account (`admin.password_reset.issued` / `password.reset.requested` outcome `denied`, reason `break_glass_designee`). The designee's credential is the last-resort path during IdP outage; letting any admin session - including a hijacked one - rotate it through a routine UI would undermine the ceremony boundary, and recovery-code-based emergency access already covers a forgotten designee password. Rotation remains exclusively via `rotateBreakGlassPassword` (`breakglass.password_rotated`).

### 5.5 Final-admin protection

A reset changes no roles, so the final-admin invariant from f7816ef is not directly engaged, and no admin can be locked out of adminship *permanently* by resets: any admin can issue a reset for any other active admin, including self. The one irreversible-looking corner - sole active admin forgetting their password with no session and no break-glass configured for them - is already covered by the break-glass designation being a separate, trigger-protected account with recovery codes, and by bootstrap-level operator access to the database in the worst case. No additional protection rule is introduced.

## 6. Rate limiting and abuse defenses

- **Request endpoint:** per source IP, 10 requests per 15 minutes; per normalized email, at most 3 tokens issued per hour. Excess requests return the identical anti-enumeration response and create no token; server-side they record `password.reset.requested` outcome `denied` reason `rate_limited`. Acknowledged trade-off: an attacker can burn a victim's per-email budget (self-inflicted DoS bounded to one hour, self-healing); the alternative - signaling the limit to the requester - breaks anti-enumeration.
- **Completion endpoint:** 10 failed submissions (unknown/used/expired/invalidated token) per IP per 15 minutes. Form validation errors (weak password, mismatch) do not consume or spoil the token. Token guessing is infeasible against 256-bit tokens, so no per-token attempt counter is maintained.
- **Counters** live in memory following the `webauthn.ts` emergency-attempts precedent (single-process SQLite deployment); a counter resets on restart, which errs toward availability, and the same precedent carries the much more sensitive break-glass ceremony.
- **Admin flow:** no anonymous surface and no extra limiter beyond the existing authenticated, governance-reasoned server action path; every issuance is audited.
- **Logging hygiene:** raw tokens never appear in logs, security events, audit events, error messages, or URLs emitted by the server other than the single email body or the one-time admin reveal. Events reference token `id` only. Token hashes are storage-only.

## 7. Phone safety mode

- Administration > Accounts follows the f7816ef pattern: in phone safety mode the **Reset password** control is omitted entirely (not disabled), while account facts remain visible. Issuance, the one-time link reveal, and the email delivery choice are desktop/tablet acts.
- The self-service request and completion pages are unauthenticated recovery pages, not governed mutation surfaces; they are fully usable on phones so a locked-out user can recover without a workstation. Phone safety mode is a governance guard, not a general mobile block.

## 8. Audit and security events

New event types (redacted, outcome-bearing, no secrets):

| Type | Outcome | When |
| --- | --- | --- |
| `password.reset.requested` | `success` / `denied` | Self-service request; denial reasons: `unknown_or_ineligible`, `rate_limited`, `break_glass_designee`, `authentik_primary_mode` |
| `password.reset.mail_failed` | `error` | Configured seam failed to deliver; requester response unchanged |
| `password.reset.completed` | `success` | Token redeemed, password rewritten, sessions retired |
| `password.reset.redeem_denied` | `denied` | Redemption rejected; reasons: `unknown_token`, `expired`, `used`, `invalidated`, `rate_limited` |
| `admin.password_reset.issued` | `success` / `denied` | Admin issuance; denial reasons: `inactive_target`, `break_glass_designee`, `credential_disabled` |

Plus the governance audit event `account.password_reset` already described in 5.1, and the existing per-session `auth.session.revoked` events emitted by `retireUserSessions`.

## 9. Test matrix

### 9.1 Unit

- Token store: issuance hashes only; raw token never persisted; digest lookup; TTL boundary (valid at 59:59, rejected at 60:00); single-use (second redemption denied `used`); supersession (new issuance invalidates prior, latest wins); completion transaction writes hash, bumps `auth_version`, revokes sessions, invalidates leftovers atomically.
- Eligibility: active+usable credential only; `NULL`, `disabled:`, inactive all treated as unknown.
- Anti-enumeration: identical response body/status for known, unknown, inactive, OIDC-only; dummy bcrypt compare invoked for ineligible emails.
- Rate limiter windows: per-IP, per-email budgets; denial recorded; limits identical for known/unknown emails.
- Auth-config: `RESET_MAIL_MODE` unset/none/smtp/invalid; malformed smtp configuration blocks readiness; readiness check copy for both ready states.
- Break-glass denial; `credential_disabled` denial; inactive-target denial.
- `authentik-primary` guard regression: options.ts still admits nobody via credentials after a reset (existing suppression tests extended with a post-reset hash).

### 9.2 Component/UI

- Sign-in surface shows the reset affordance in `local`/`dual`, hides it in `authentik-primary`.
- Request page copy is identical in both mail states and points to the administrator.
- Completion page: token states render one generic failure; success page links to sign-in; no auto-login.
- Admin Accounts row: reset control present on desktop/tablet, omitted under phone safety mode; governed reason required; one-time reveal appears exactly once with expiry; email delivery choice shown only when configured; self-reset warning.
- Hydration safety: no mutation-control flash before phone classification (existing hook contract).

### 9.3 E2E (container suite, `scripts/run-e2e-appliance.sh`)

- Full self-service happy path with the seam configured (test SMTP sink captures the message; assert the link, single transactional template, no other content).
- Mail unconfigured: request returns the identical response; nothing is sent; operator-assisted admin issuance completes the recovery.
- Enumeration resistance: fixed corpus of known/unknown/inactive emails yields indistinguishable responses.
- Token expiry and reuse: expired link denied; reusing a consumed link denied; superseded link denied after a newer issuance.
- Session revocation breadth: hold simultaneous local, Authentik, and break_glass-sourced sessions for the target (per test fixtures), complete a reset, assert every row revoked and every subsequent request rejected.
- Admin policies: precedence over an in-flight self-service token; self-reset flow; break-glass denial; inactive-target denial; `disabled:` credential denial; OIDC-only credential installation in `dual`.
- Phone emulation: no reset mutation controls in the admin UI; self-service pages remain usable.
- Rate limiting: budget burn behavior and identical responses; per-email budget burn does not signal existence.

## 10. Out of scope

Signed-in password change, account deactivation, any other transactional or notification mail, multi-transport or templated mail, self-service reset in `authentik-primary`, upstream Authentik session termination, and any change to the deployment profile value set.

## 11. Self-review notes

Checked before commit: no placeholders or TODOs remain; TTL (60 min), bcrypt cost (12), rate budgets, and table columns are stated once each and used consistently; sections 4.1 and 5.1 intentionally differ on when sessions are retired (request vs. issuance) and the asymmetry is justified in place; the mail seam is stated to be mail-only for resets with no path for other content, consistent with the captain's scoped posture change; phone safety, phone-usable self-service pages, and the `authentik-primary` suppression guard are asserted without contradiction with existing invariants; all new security event types are enumerated and none carry secrets, tokens, or raw email addresses.
