"use client";

import Link from "next/link";
import { useId, useState, useTransition, type FormEvent } from "react";
import { passwordResetCompletionSchema } from "@/lib/password-reset";
import type { CompletePasswordResetActionResult } from "@/server/actions/password-reset-actions";

export function PasswordResetCompletionForm({
  token,
  action,
}: {
  token: string;
  action: (input: {
    token: string;
    password: string;
    confirmPassword: string;
  }) => Promise<CompletePasswordResetActionResult>;
}) {
  const passwordId = useId();
  const confirmId = useId();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    password?: string;
    confirmPassword?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) {
      return;
    }
    setFieldErrors({});
    setFormError(null);

    const parsed = passwordResetCompletionSchema.safeParse({
      token,
      password,
      confirmPassword,
    });
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      setFieldErrors({
        password: flat.fieldErrors.password?.[0],
        confirmPassword: flat.fieldErrors.confirmPassword?.[0],
      });
      return;
    }

    startTransition(async () => {
      const result = await action({
        token,
        password: parsed.data.password,
        confirmPassword: parsed.data.confirmPassword,
      });
      if (result.ok) {
        setSuccess(result.message);
      } else if (result.fieldErrors?.password || result.fieldErrors?.confirmPassword) {
        setFieldErrors(result.fieldErrors);
      } else {
        setFormError(result.message);
      }
    });
  }

  if (success) {
    return (
      <div className="auth-confirmation" role="status">
        <p>{success}</p>
        <p>
          <Link href="/">Sign in</Link>
        </p>
      </div>
    );
  }

  return (
    <form className="form-grid auth-form" method="post" noValidate onSubmit={handleSubmit}>
      {formError ? (
        <div className="error-summary" role="alert">
          <p>{formError}</p>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={passwordId}>New password</label>
        <input
          autoComplete="new-password"
          id={passwordId}
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
        {fieldErrors.password ? (
          <p className="field-error" role="alert">
            {fieldErrors.password}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={confirmId}>Confirm new password</label>
        <input
          autoComplete="new-password"
          id={confirmId}
          name="confirmPassword"
          onChange={(event) => setConfirmPassword(event.target.value)}
          type="password"
          value={confirmPassword}
        />
        {fieldErrors.confirmPassword ? (
          <p className="field-error" role="alert">
            {fieldErrors.confirmPassword}
          </p>
        ) : null}
      </div>
      <button className="button button-primary" disabled={isPending} type="submit">
        {isPending ? "Resetting..." : "Set new password"}
      </button>
    </form>
  );
}
