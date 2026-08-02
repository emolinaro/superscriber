"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { sanitizeReturnTo } from "@/lib/safe-return-to";
import { consumeBootstrapEmailAction } from "@/server/actions/auth-actions";

function buildPostLoginPath(returnTo: string) {
  return `/?returnTo=${encodeURIComponent(returnTo)}`;
}

function signInErrorCode(result: { error?: string | null; url?: string | null } | undefined) {
  if (result?.error) {
    return result.error;
  }

  if (!result?.url) {
    return null;
  }

  try {
    return new URL(result.url, window.location.origin).searchParams.get("error");
  } catch {
    return null;
  }
}

export function LoginForm({
  initialEmail = "",
  returnTo = "/workspace",
}: {
  initialEmail?: string;
  returnTo?: string;
}) {
  const summaryHeadingId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorMode, setErrorMode] = useState<"credentials" | "service" | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (errorMode === "service") {
      summaryRef.current?.focus();
    }
  }, [errorMode]);

  function clearPassword() {
    if (passwordRef.current) {
      passwordRef.current.value = "";
      passwordRef.current.focus();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const callbackUrl = sanitizeReturnTo(returnTo);

    setError(null);
    setErrorMode(null);

    startTransition(async () => {
      if (initialEmail) {
        await consumeBootstrapEmailAction();
      }

      let result:
        | {
            error?: string | null;
            url?: string | null;
            status?: number;
          }
        | undefined;

      try {
        result = await signIn("credentials", {
          email,
          password,
          redirect: false,
          callbackUrl,
        });
      } catch {
        result = undefined;
      }

      const errorCode = signInErrorCode(result);

      if (errorCode === "CredentialsSignin" || result?.status === 401) {
        clearPassword();
        setError("Email or password was not accepted. Check both fields and try again.");
        setErrorMode("credentials");
        return;
      }

      if (!result || errorCode || !result.url) {
        clearPassword();
        setError("Sign-in could not be completed. Your password was not saved. Try again.");
        setErrorMode("service");
        return;
      }

      window.location.assign(buildPostLoginPath(callbackUrl));
    });
  }

  return (
    <form className="form-grid auth-form" method="post" noValidate onSubmit={handleSubmit}>
      {error ? (
        <div
          aria-labelledby={summaryHeadingId}
          className="error-summary"
          ref={summaryRef}
          role="alert"
          tabIndex={-1}
        >
          <h2 className="error-summary__title" id={summaryHeadingId}>
            There is a problem
          </h2>
          <p>{error}</p>
        </div>
      ) : null}

      <div className="field">
        <label className="field-label" htmlFor="login-email">
          Email
        </label>
        <input
          aria-invalid={errorMode === "credentials" ? true : undefined}
          autoComplete="email"
          defaultValue={initialEmail}
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
          aria-invalid={errorMode === "credentials" ? true : undefined}
          autoComplete="current-password"
          id="login-password"
          name="password"
          ref={passwordRef}
          required
          type="password"
        />
      </div>

      <button className="button button-primary" disabled={isPending} type="submit">
        {isPending ? "Signing in..." : "Sign in"}
      </button>

      <p className="field-note">Passwords are never saved in the browser after a failed sign-in.</p>
    </form>
  );
}
