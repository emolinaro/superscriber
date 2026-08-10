# No-mail deployment profile

Mail is disabled by design. There is no SMTP integration, no transactional
mail, no notification surface, and no email-based identity matching anywhere
in the application.

## What this means operationally

- `SUPERSCRIBER_DEPLOYMENT_PROFILE=no-mail` is the only valid value and the
  default. Anything else blocks readiness.
- The **Deployment profile** readiness check reports the no-mail state; no
  SMTP settings are required or consulted.
- Account onboarding is a local act: administrators create local users, and
  identity links are provisioned exactly (see `identity-linking.md`).
- Authentik enrollment and recovery flows that involve mail stages live in
  the provider, outside this deployment's data plan; target flows must be
  verified browsable without SMTP before rollout acceptance.

## Verifying no mail surfaces exist

```bash
grep -ri "smtp\|nodemailer\|sendmail" package.json src app --include="*.ts" --include="*.tsx" \
  | grep -v "no-mail\|reset-mail\|password_reset\|password-reset" || echo "no mail surfaces"
```

The expected output is `no mail surfaces` (this document's own references
and the scoped password-reset seam aside).

## Scoped exception: password reset

Mail stays disabled by default, with one captain-approved carve-out: the
password-reset path. When an operator explicitly configures
`SUPERSCRIBER_RESET_MAIL_MODE=smtp` plus its companion settings, the
deployment may send exactly one transactional template: the single-use reset
link and its expiry. Nothing else - no notifications, no content, no other
feature - can send mail. With the seam unconfigured (the default), resets run
operator-assisted: administrators issue reset links and hand them over
out-of-band. See `password-reset.md` for configuration, degradation behavior,
and the audit trail.
