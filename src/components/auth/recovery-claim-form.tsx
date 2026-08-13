"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { ErrorSummary } from "@/components/ui/error-summary";
import { claimRecoveryAdminAction } from "@/server/actions/auth-actions";
import {
  CONFIRM_PASSWORD_REQUIRED_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
} from "@/server/auth/validation";
import {
  EMPTY_RECOVERY_CLAIM_FORM_STATE,
  type RecoveryClaimFieldName,
  type RecoveryClaimFormState,
} from "@/lib/auth-forms";

const FIELD_CONFIG: Record<
  RecoveryClaimFieldName,
  {
    id: string;
    label: string;
  }
> = {
  displayName: {
    id: "recovery-display-name",
    label: "Administrator name",
  },
  email: {
    id: "recovery-email",
    label: "Administrator email",
  },
  password: {
    id: "recovery-password",
    label: "Password",
  },
  confirmPassword: {
    id: "recovery-confirm-password",
    label: "Confirm password",
  },
  claimToken: {
    id: "recovery-claim-token",
    label: "Operator claim token",
  },
};

export function RecoveryClaimForm({
  action = claimRecoveryAdminAction,
  claimTokenPath,
}: {
  action?: (
    previousState: RecoveryClaimFormState,
    formData: FormData,
  ) => Promise<RecoveryClaimFormState>;
  claimTokenPath: string;
}) {
  const [state, formAction, isPending] = useActionState(action, EMPTY_RECOVERY_CLAIM_FORM_STATE);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  // Live match check before any submit attempt; the confirm value reaches the
  // server only as match-validation input, never as stored data.
  const [credentials, setCredentials] = useState({ password: "", confirmPassword: "" });
  const [submittedConfirmPasswordError, setSubmittedConfirmPasswordError] = useState<
    string | undefined
  >();
  const passwordsMismatch =
    credentials.confirmPassword.length > 0 &&
    credentials.password !== credentials.confirmPassword;
  const effectiveFieldErrors = useMemo(
    () => ({
      ...(state.fieldErrors ?? {}),
      ...(submittedConfirmPasswordError
        ? { confirmPassword: submittedConfirmPasswordError }
        : {}),
    }),
    [state.fieldErrors, submittedConfirmPasswordError],
  );
  const confirmPasswordError = passwordsMismatch
    ? PASSWORD_MISMATCH_MESSAGE
    : effectiveFieldErrors.confirmPassword;

  const summaryErrors = useMemo(
    () =>
      (Object.entries(effectiveFieldErrors) as Array<
        [RecoveryClaimFieldName, string | undefined]
      >)
        .filter(([, message]) => typeof message === "string" && Boolean(message))
        .map(([field, message]) => ({
          fieldId: FIELD_CONFIG[field].id,
          label: FIELD_CONFIG[field].label,
          message: message!,
        })),
    [effectiveFieldErrors],
  );

  useEffect(() => {
    if (!state.formError && Object.keys(state.fieldErrors ?? {}).length === 0) {
      return;
    }

    // Passwords are cleared after every failed attempt; the claim token
    // stays editable so the operator can correct a transcription slip.
    if (passwordRef.current) {
      passwordRef.current.value = "";
    }
    if (confirmPasswordRef.current) {
      confirmPasswordRef.current.value = "";
    }
    setCredentials({ password: "", confirmPassword: "" });
    setSubmittedConfirmPasswordError(undefined);
  }, [state]);

  useEffect(() => {
    if (submittedConfirmPasswordError) {
      confirmPasswordRef.current?.focus();
    }
  }, [submittedConfirmPasswordError]);

  function updateCredential(field: "password" | "confirmPassword", value: string) {
    setCredentials((current) => ({ ...current, [field]: value }));
    setSubmittedConfirmPasswordError(undefined);
  }

  function errorFor(field: RecoveryClaimFieldName) {
    return effectiveFieldErrors[field];
  }

  function describedBy(field: RecoveryClaimFieldName) {
    if (field === "confirmPassword") {
      return confirmPasswordError ? "confirmPassword-error" : undefined;
    }
    if (field === "password") {
      const ids = [
        errorFor("password") ? "password-error" : null,
        passwordsMismatch ? "confirmPassword-error" : null,
      ].filter((id): id is string => Boolean(id));
      return ids.length > 0 ? ids.join(" ") : undefined;
    }
    return errorFor(field) ? `${field}-error` : undefined;
  }

  return (
    <div className="stack auth-form-shell">
      <p className="body-copy">
        Because anyone who could claim this form first would own the appliance, claiming is closed
        to the network: the claim token proves shell access to this machine and is single-use,
        rate-limited, and audited, so a network attacker cannot race the operator to it.
      </p>

      <ErrorSummary errors={summaryErrors} />

      <form
        action={formAction}
        className="form-grid auth-form"
        noValidate
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            event.target instanceof HTMLInputElement &&
            passwordsMismatch
          ) {
            event.preventDefault();
            setSubmittedConfirmPasswordError(PASSWORD_MISMATCH_MESSAGE);
            confirmPasswordRef.current?.focus();
          }
        }}
        onSubmit={(event) => {
          // Direct form submissions must hold the same match guard.
          const submittedError =
            credentials.confirmPassword.length === 0
              ? CONFIRM_PASSWORD_REQUIRED_MESSAGE
              : passwordsMismatch
                ? PASSWORD_MISMATCH_MESSAGE
                : undefined;
          if (submittedError) {
            event.preventDefault();
            setSubmittedConfirmPasswordError(submittedError);
            confirmPasswordRef.current?.focus();
          }
        }}
      >
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
            aria-invalid={errorFor("password") || passwordsMismatch ? true : undefined}
            autoComplete="new-password"
            id={FIELD_CONFIG.password.id}
            name="password"
            onChange={(event) => updateCredential("password", event.target.value)}
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
            aria-invalid={confirmPasswordError ? true : undefined}
            autoComplete="new-password"
            id={FIELD_CONFIG.confirmPassword.id}
            name="confirmPassword"
            onChange={(event) => updateCredential("confirmPassword", event.target.value)}
            ref={confirmPasswordRef}
            required
            type="password"
          />
          {confirmPasswordError ? (
            <p
              className="field-error-message"
              id="confirmPassword-error"
              role={passwordsMismatch ? "alert" : undefined}
            >
              {confirmPasswordError}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={FIELD_CONFIG.claimToken.id}>
            {FIELD_CONFIG.claimToken.label}
          </label>
          <input
            aria-describedby={
              describedBy("claimToken")
                ? `${describedBy("claimToken")} claimToken-note`
                : "claimToken-note"
            }
            aria-invalid={errorFor("claimToken") ? true : undefined}
            autoComplete="off"
            id={FIELD_CONFIG.claimToken.id}
            name="claimToken"
            required
            spellCheck={false}
            type="text"
          />
          <p className="field-note" id="claimToken-note">
            Read the token from <code>{claimTokenPath}</code> on this machine. Dashes and letter
            case do not matter.
          </p>
          {errorFor("claimToken") ? (
            <p className="field-error-message" id="claimToken-error">
              {errorFor("claimToken")}
            </p>
          ) : null}
        </div>

        {state.formError && summaryErrors.length === 0 ? (
          <p className="field-error-message" role="alert">
            {state.formError}
          </p>
        ) : null}

        <button
          className="button button-primary"
          disabled={isPending || passwordsMismatch}
          type="submit"
        >
          {isPending ? "Creating account..." : "Claim administrator"}
        </button>

        <p className="field-note">
          Only the administrator name and email stay in the form after an error. Passwords are
          cleared every time.
        </p>
      </form>
    </div>
  );
}
