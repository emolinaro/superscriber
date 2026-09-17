"use client";
import { SelfDeactivation } from "./self-deactivation";
import type { AppUser } from "@/domain/models";
import { formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import { usePhoneSafetyMode } from "@/components/ui/phone-safety";

export function AccountPage({ account }: { account: AppUser }) {
  const phoneSafetyMode = usePhoneSafetyMode();
  return (
    <div className="shell account-shell stack">
      <section className="surface-intro">
        <div className="surface-intro__copy stack-tight">
          <p className="surface-intro__eyebrow">Account</p>
          <h1 className="surface-intro__title">Your account</h1>
          <p className="surface-intro__description">
            Your account details and access on this appliance.
          </p>
        </div>
      </section>
      {phoneSafetyMode ? (
        <p className="panel panel-strong panel-inner" role="status">
          Phone safety mode: account information is read-only.
        </p>
      ) : null}
      <section
        className="panel panel-strong panel-inner stack"
        aria-labelledby="account-details-heading"
      >
        <h2 className="section-title" id="account-details-heading">
          Account details
        </h2>
        <dl className="administration-fact-list account-details">
          <div>
            <dt>Name</dt>
            <dd>{account.displayName}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{account.email}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{formatRoleLabel(account.role)}</dd>
          </div>
          <div>
            <dt>Account state</dt>
            <dd>{account.isActive ? "Active" : "Deactivated"}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>
              <time dateTime={account.createdAt}>
                {formatDateTimeUtc(account.createdAt)}
              </time>
            </dd>
          </div>
        </dl>
      </section>
      <section
        className="panel panel-strong panel-inner stack"
        aria-labelledby="account-access-heading"
      >
        <h2 className="section-title" id="account-access-heading">
          Manage account access
        </h2>
        <p className="body-copy">
          You can deactivate your own account below and restore access by
          signing in again. Deactivation signs you out everywhere. If an
          administrator deactivates your account, only an administrator can
          reactivate it. Contact an administrator to remove account access.
        </p>
        <p className="body-copy">
          Removal offboards your account: it clears the local password and
          retires linked sign-in identities. Your account record and governed
          history remain for attribution.
        </p>
        <p className="body-copy">
          Password reset is separate. Use Forgot password on the sign-in page,
          or ask an administrator for a reset link. If you sign in through an
          identity provider, manage your password there.
        </p>
        <div className="button-row">
          {!phoneSafetyMode ? <SelfDeactivation userId={account.id} /> : null}
          {account.role === "admin" && !phoneSafetyMode ? (
            <a
              className="button button-secondary"
              href="/administration?section=accounts"
            >
              Open account administration
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}
