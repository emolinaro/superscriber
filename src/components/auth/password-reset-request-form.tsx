"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { passwordResetRequestSchema } from "@/lib/password-reset";
import type { PasswordResetRequestActionResult } from "@/server/actions/password-reset-actions";

export function PasswordResetRequestForm({
  action,
}: {
  action: (input: { email: string }) => Promise<PasswordResetRequestActionResult>;
}) {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) {
      return;
    }
    setFieldError(null);

    const parsed = passwordResetRequestSchema.safeParse({ email: email.trim() });
    if (!parsed.success) {
      setFieldError(
        parsed.error.flatten().fieldErrors.email?.[0] ?? "Enter a valid email address.",
      );
      return;
    }

    startTransition(async () => {
      const result = await action({ email: parsed.data.email });
      if (result.ok) {
        // Anti-enumeration: once confirmed, the form is gone for everyone.
        setConfirmation(result.message);
      } else {
        setFieldError(result.fieldErrors.email ?? "Enter a valid email address.");
      }
    });
  }

  if (confirmation) {
    return (
      <p className="auth-confirmation" role="status">
        {confirmation}
      </p>
    );
  }

  return (
    <form className="form-grid auth-form" method="post" noValidate onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor={emailId}>Email</label>
        <input
          autoComplete="email"
          id={emailId}
          inputMode="email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
        {fieldError ? (
          <p className="field-error" role="alert">
            {fieldError}
          </p>
        ) : null}
      </div>
      <button className="button button-primary" disabled={isPending} type="submit">
        {isPending ? "Starting reset..." : "Reset password"}
      </button>
    </form>
  );
}
