"use client";

import { useState, type FormEvent } from "react";
import { completeMandatoryPasswordChangeAction } from "@/server/actions/account-lifecycle-actions";

export function MandatoryPasswordChange({
  userId,
  returnTo,
  navigate = (href: string) => window.location.assign(href),
}: {
  userId: string;
  returnTo: string;
  navigate?: (href: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await completeMandatoryPasswordChangeAction({
        expectedActorUserId: userId,
        password,
        confirmPassword,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      navigate(returnTo);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="panel panel-strong stack" noValidate onSubmit={submit}>
      <div className="panel-inner stack">
        <div className="stack-tight">
          <p className="eyebrow">Temporary password</p>
          <h1 className="section-title">Choose your password</h1>
          <p className="body-copy">
            Your administrator-created temporary password expires now. Choose a
            new password before continuing.
          </p>
        </div>
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={200}
            value={password}
            disabled={pending}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="confirm-password">Confirm password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={200}
            value={confirmPassword}
            disabled={pending}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>
        {error ? (
          <p className="field-error-message" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <button className="button button-primary" type="submit" disabled={pending}>
            {pending ? "Changing password..." : "Change password"}
          </button>
        </div>
      </div>
    </form>
  );
}
