"use client";

import { useActionState } from "react";
import { createBootstrapAdminAction } from "@/app/actions";
import {
  EMPTY_BOOTSTRAP_FORM_STATE,
  type BootstrapFieldName,
} from "@/lib/auth-forms";

const FIELD_SEQUENCE: BootstrapFieldName[] = [
  "displayName",
  "email",
  "password",
  "confirmPassword",
];

export function BootstrapSetupForm() {
  const [state, action, isPending] = useActionState(
    createBootstrapAdminAction,
    EMPTY_BOOTSTRAP_FORM_STATE,
  );

  function errorFor(field: BootstrapFieldName) {
    return state.fieldErrors?.[field];
  }

  function describedBy(field: BootstrapFieldName) {
    return errorFor(field) ? `${field}-error` : undefined;
  }

  return (
    <form action={action} className="form-grid auth-form" noValidate>
      <div className="field">
        <label className="field-label" htmlFor="bootstrap-display-name">
          Administrator name
        </label>
        <input
          aria-describedby={describedBy("displayName")}
          aria-invalid={errorFor("displayName") ? true : undefined}
          autoComplete="name"
          defaultValue={state.values?.displayName ?? ""}
          id="bootstrap-display-name"
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
        <label className="field-label" htmlFor="bootstrap-email">
          Administrator email
        </label>
        <input
          aria-describedby={describedBy("email")}
          aria-invalid={errorFor("email") ? true : undefined}
          autoComplete="email"
          defaultValue={state.values?.email ?? ""}
          id="bootstrap-email"
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
        <label className="field-label" htmlFor="bootstrap-password">
          Password
        </label>
        <input
          aria-describedby={describedBy("password")}
          aria-invalid={errorFor("password") ? true : undefined}
          autoComplete="new-password"
          id="bootstrap-password"
          name="password"
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
        <label className="field-label" htmlFor="bootstrap-confirm-password">
          Confirm password
        </label>
        <input
          aria-describedby={describedBy("confirmPassword")}
          aria-invalid={errorFor("confirmPassword") ? true : undefined}
          autoComplete="new-password"
          id="bootstrap-confirm-password"
          name="confirmPassword"
          required
          type="password"
        />
        {errorFor("confirmPassword") ? (
          <p className="field-error-message" id="confirmPassword-error">
            {errorFor("confirmPassword")}
          </p>
        ) : null}
      </div>

      <div aria-live="polite" className="auth-status">
        {state.formError ? (
          <p className="field-error-message" role="alert">
            {state.formError}
          </p>
        ) : null}
      </div>

      <button className="button button-primary" disabled={isPending} type="submit">
        {isPending ? "Creating account..." : "Create admin"}
      </button>

      <div className="stack-tight">
        {FIELD_SEQUENCE.some((field) => errorFor(field)) ? (
          <p className="field-note">
            Review the highlighted fields. Setup does not continue until the first
            admin account is valid and saved.
          </p>
        ) : null}
      </div>
    </form>
  );
}
