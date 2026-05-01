"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

export function LoginForm() {
  const router = useRouter();
  const errorId = useId();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    setError(null);

    startTransition(async () => {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl: "/workspace",
      });

      if (!result || result.error) {
        setError("Wrong email or password. Check the details and try again.");
        return;
      }

      router.push(result.url ?? "/workspace");
      router.refresh();
    });
  }

  return (
    <form className="form-grid auth-form" noValidate onSubmit={handleSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="login-email">
          Email
        </label>
        <input
          autoComplete="email"
          id="login-email"
          name="email"
          required
          type="email"
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="login-password">
          Password
        </label>
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="current-password"
          id="login-password"
          name="password"
          required
          type="password"
        />
      </div>

      <div aria-live="polite" className="auth-status">
        {error ? (
          <p className="field-error-message" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <button className="button button-primary" disabled={isPending} type="submit">
        {isPending ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
