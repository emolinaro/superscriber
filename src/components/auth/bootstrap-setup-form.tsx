"use client";

import { useActionState, useEffect, useMemo, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ErrorSummary } from "@/components/ui/error-summary";
import { createBootstrapAdminAction } from "@/server/actions/auth-actions";
import {
  EMPTY_BOOTSTRAP_FORM_STATE,
  type BootstrapFieldName,
  type BootstrapFormState,
} from "@/lib/auth-forms";
import { type BootstrapReadiness } from "@/server/bootstrap/readiness";

const FIELD_CONFIG: Record<
  BootstrapFieldName,
  {
    id: string;
    label: string;
  }
> = {
  displayName: {
    id: "bootstrap-display-name",
    label: "Administrator name",
  },
  email: {
    id: "bootstrap-email",
    label: "Administrator email",
  },
  password: {
    id: "bootstrap-password",
    label: "Password",
  },
  confirmPassword: {
    id: "bootstrap-confirm-password",
    label: "Confirm password",
  },
};

function stateTone(state: BootstrapReadiness["checks"][number]["state"]) {
  if (state === "blocked") {
    return "danger";
  }
  if (state === "warning") {
    return "warn";
  }
  return "ok";
}

export function BootstrapSetupForm({
  action = createBootstrapAdminAction,
  readiness,
}: {
  action?: (
    previousState: BootstrapFormState,
    formData: FormData,
  ) => Promise<BootstrapFormState>;
  readiness: BootstrapReadiness;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(action, EMPTY_BOOTSTRAP_FORM_STATE);
  const [isRefreshing, startRefresh] = useTransition();
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  const summaryErrors = useMemo(
    () =>
      (Object.entries(state.fieldErrors ?? {}) as Array<[BootstrapFieldName, string | undefined]>)
        .filter(([, message]) => typeof message === "string" && Boolean(message))
        .map(([field, message]) => ({
          fieldId: FIELD_CONFIG[field].id,
          label: FIELD_CONFIG[field].label,
          message: message!,
        })),
    [state.fieldErrors],
  );

  useEffect(() => {
    if (!state.formError && summaryErrors.length === 0) {
      return;
    }

    if (passwordRef.current) {
      passwordRef.current.value = "";
    }
    if (confirmPasswordRef.current) {
      confirmPasswordRef.current.value = "";
    }
  }, [state.formError, summaryErrors.length]);

  function errorFor(field: BootstrapFieldName) {
    return state.fieldErrors?.[field];
  }

  function describedBy(field: BootstrapFieldName) {
    return errorFor(field) ? `${field}-error` : undefined;
  }

  const isBlocked = readiness.overall === "blocked";

  return (
    <div className="stack auth-form-shell">
      <div className="auth-readiness card-like stack-tight">
        <div className="button-row auth-readiness__header">
          <h2 className="card-title">Readiness checks</h2>
          <button
            className="button button-secondary"
            disabled={isRefreshing}
            onClick={() => {
              startRefresh(() => {
                router.refresh();
              });
            }}
            type="button"
          >
            {isRefreshing ? "Checking..." : "Retry checks"}
          </button>
        </div>
        <ul className="auth-readiness__list">
          {readiness.checks.map((check) => (
            <li className="auth-readiness__item" data-state={check.state} key={check.id}>
              <div className="button-row auth-readiness__item-row">
                <span className="field-label">{check.label}</span>
                <span className="pill" data-tone={stateTone(check.state)}>
                  {check.state}
                </span>
              </div>
              <p className="field-note">{check.detail}</p>
            </li>
          ))}
        </ul>
        {isBlocked ? (
          <p className="field-error-message">
            Fix the blocked readiness checks before creating the first administrator.
          </p>
        ) : readiness.overall === "warning" ? (
          <p className="field-note">
            Setup can continue, but the warning should be resolved before daily use.
          </p>
        ) : null}
      </div>

      <ErrorSummary errors={summaryErrors} />

      <form action={formAction} className="form-grid auth-form" noValidate>
        <div className="field">
          <label className="field-label" htmlFor={FIELD_CONFIG.displayName.id}>
            {FIELD_CONFIG.displayName.label}
          </label>
          <input
            aria-describedby={describedBy("displayName")}
            aria-invalid={errorFor("displayName") ? true : undefined}
            autoComplete="name"
            defaultValue={state.values?.displayName ?? ""}
            id={FIELD_CONFIG.displayName.id}
            name="displayName"
            required
            type="text"
          />
          {errorFor("displayName") ? (
            <p className="field-error-message" id="displayName-error">
              {errorFor("displayName")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={FIELD_CONFIG.email.id}>
            {FIELD_CONFIG.email.label}
          </label>
          <input
            aria-describedby={describedBy("email")}
            aria-invalid={errorFor("email") ? true : undefined}
            autoComplete="email"
            defaultValue={state.values?.email ?? ""}
            id={FIELD_CONFIG.email.id}
            name="email"
            required
            type="email"
          />
          {errorFor("email") ? (
            <p className="field-error-message" id="email-error">
              {errorFor("email")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={FIELD_CONFIG.password.id}>
            {FIELD_CONFIG.password.label}
          </label>
          <input
            aria-describedby={describedBy("password")}
            aria-invalid={errorFor("password") ? true : undefined}
            autoComplete="new-password"
            id={FIELD_CONFIG.password.id}
            name="password"
            ref={passwordRef}
            required
            type="password"
          />
          {errorFor("password") ? (
            <p className="field-error-message" id="password-error">
              {errorFor("password")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={FIELD_CONFIG.confirmPassword.id}>
            {FIELD_CONFIG.confirmPassword.label}
          </label>
          <input
            aria-describedby={describedBy("confirmPassword")}
            aria-invalid={errorFor("confirmPassword") ? true : undefined}
            autoComplete="new-password"
            id={FIELD_CONFIG.confirmPassword.id}
            name="confirmPassword"
            ref={confirmPasswordRef}
            required
            type="password"
          />
          {errorFor("confirmPassword") ? (
            <p className="field-error-message" id="confirmPassword-error">
              {errorFor("confirmPassword")}
            </p>
          ) : null}
        </div>

        {state.formError && summaryErrors.length === 0 ? (
          <p className="field-error-message" role="alert">
            {state.formError}
          </p>
        ) : null}

        <button className="button button-primary" disabled={isPending || isBlocked} type="submit">
          {isPending ? "Creating account..." : "Create admin"}
        </button>

        <p className="field-note">
          Only the administrator name and email stay in the form after an error. Passwords are
          cleared every time.
        </p>
      </form>
    </div>
  );
}
