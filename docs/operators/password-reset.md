# Password reset operations

Two flows recover local passwords: self-service email reset, and administrator
manual reset. Administrator issuance always wins over an in-flight
self-service flow: it invalidates outstanding reset tokens and ends every
session of the target account immediately.

## Self-service reset

- The sign-in surface links to `/reset-request` whenever the local credential
  form is offered (auth modes `local` and `dual`). In `authentik-primary`,
  credentials admit nobody, so no reset affordance is shown.
- The response is identical for known and unknown emails, and varies only
  with the instance-wide mail posture, so the flow cannot be used to enumerate
  accounts. With the reset-mail seam configured, the confirmation is: "If an
  account matches that email, a password reset has been started. If nothing
  arrives, contact your administrator." With the seam unconfigured or
  misconfigured (nothing can be delivered), the confirmation says so plainly:
  "This instance does not send email. Your administrator can reset your
  password for you from Administration > Accounts."
- A request alone changes nothing: no session is revoked, no password is
  touched. Only completing a reset rotates the credential, advances
  `auth_version`, and revokes every session from every auth source (local,
  Authentik, break-glass).
- Reset links are single-use, expire 60 minutes after issuance, and only the
  newest link for an account is live. Only the SHA-256 digest of the link
  secret is stored; the raw link is never logged.
- A request alone requires an existing usable local credential. OIDC-only
  accounts and accounts whose credential was retired by a break-glass
  transfer are treated like unknown emails; the deliberate version of
  restoring a credential is the administrator flow below.

## Reset mail (opt-in)

Mail remains disabled by default (`no-mail` profile; see
`no-mail-profile.md`). The reset path is the approved exception and can send
exactly one transactional template: the link and its absolute expiry.

| Setting | Required for `smtp` | Purpose |
| --- | --- | --- |
| `SUPERSCRIBER_RESET_MAIL_MODE` | yes (`smtp`) | unset or `none` keeps the seam off |
| `SUPERSCRIBER_RESET_MAIL_SMTP_HOST` | yes | submission host |
| `SUPERSCRIBER_RESET_MAIL_SMTP_PORT` | yes | 587 (STARTTLS) or 465 (implicit TLS) |
| `SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS` | yes | sender address |
| `SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE` | yes | mounted secret file (path only) |
| `SUPERSCRIBER_RESET_MAIL_USERNAME` | no | auth user; defaults to the from address |
| `SUPERSCRIBER_RESET_MAIL_BASE_URL` | no | public origin for links; defaults to the request origin |

Unknown modes or malformed smtp settings block the **Reset mail** readiness
check. When the seam is unconfigured, readiness reports the ready state
"operator-assisted": self-service requests still answer identically and
simply send nothing; the administrator flow is the working recovery path. A
delivery failure never changes the requester's response; it records a
`password.reset.mail_failed` security event instead. Changes require a
restart.

## Administrator manual reset

Administration > Accounts offers **Reset password** on every active account
(tablet and desktop only; phone safety mode hides all mutation controls).

1. Enter a governed reason (10-500 characters).
2. Choose delivery: out-of-band handoff (always available; the link is shown
   exactly once with its expiry) or email (only when the seam is configured;
   the link is never shown to the administrator).
3. Issuance immediately signs the target out everywhere, cancels any reset
   already in progress, and produces one single-use 60-minute link.

Boundaries:

- Inactive accounts cannot be reset.
- The designated break-glass administrator cannot be reset here; that
  credential rotates only through the emergency ceremony
  (`breakglass.password_rotated`).
- Accounts whose local credential was retired by a break-glass transfer
  (`disabled:` sentinel) cannot be reset here either.
- An OIDC-only account can receive a fresh local credential through this
  flow (audited, deliberate); in `authentik-primary` that credential still
  signs nobody in until the auth mode changes.
- Resetting your own account is allowed; your session ends immediately and
  you complete the reset with the new link.

## Audit trail

- Governance: `account.password_reset` audit event with actor, target, and
  reason (Administration audit surface).
- Security events: `password.reset.requested` (success/denied with reason),
  `password.reset.mail_failed` (error), `password.reset.completed`,
  `password.reset.redeem_denied` (reason: unknown_token, expired, used,
  invalidated, rate_limited), `admin.password_reset.issued` (success/denied,
  denial code). None of these contain link material or email addresses.

## Rate limits

- Requests: 10 per source IP per 15 minutes; at most 3 tokens per email per
  hour. Over-budget requests get the same generic response (no limit
  disclosure) and a denial event.
- Redemptions: 10 failed attempts per IP per 15 minutes. Form validation
  errors do not consume a link.

## Recovery playbook (no mail configured)

1. User reports being locked out.
2. Administration > Accounts > the user's row > **Reset password** with a
   reason, delivery "Out-of-band handoff".
3. Copy the one-time link and deliver it by a channel you trust (in person,
   phone call, existing secure channel) before the 60-minute expiry.
4. The user sets a new password; all of their previous sessions are already
   revoked. They sign in fresh.
