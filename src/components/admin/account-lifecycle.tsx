"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import {
  ACCOUNT_LIFECYCLE_LABELS,
  accountLifecycleInputSchema,
  type AccountLifecycleInput,
} from "@/lib/account-lifecycle";
import { changeAccountLifecycleAction } from "@/server/actions/administration-actions";

export function AccountLifecycleModal({
  account,
  kind,
  currentUserId,
  onClose,
  onChanged,
  action = changeAccountLifecycleAction,
}: {
  account: {
    id: string;
    displayName: string;
    isActive: boolean;
    hasActiveOidcIdentity: boolean;
    activeAssignmentCount: number;
  };
  kind: AccountLifecycleInput["action"];
  currentUserId: string;
  onClose: () => void;
  onChanged: (isActive: boolean, notice: string) => void;
  action?: typeof changeAccountLifecycleAction;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setError(null);
    setFieldError(null);
    const parsed = accountLifecycleInputSchema.safeParse({
      userId: account.id,
      action: kind,
      expectedIsActive: account.isActive,
      reason,
    });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Enter a reason.");
      reasonRef.current?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      const result = await action({
        ...parsed.data,
        expectedActorUserId: currentUserId,
      });
      if (!mounted.current) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onChanged(result.data.isActive, result.notice ?? "Account updated.");
      onClose();
    } catch {
      if (mounted.current)
        setError(
          "The account action could not be confirmed. Refresh the account before trying again.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <Modal
      open
      title={`${ACCOUNT_LIFECYCLE_LABELS[kind]}: ${account.displayName}`}
      onClose={() => {
        if (!busy.current) onClose();
      }}
    >
      <form className="form-grid" noValidate onSubmit={submit}>
        <p className="body-copy">
          {kind === "remove"
            ? "Remove this account's access: deactivate it, clear its local password, and retire its linked sign-in identities. Its account record, email reservation, assignments, and audit history remain. This is offboarding; it does not erase the person's history."
            : kind === "deactivate"
              ? "Sign this account out everywhere and prevent further sign-in. Its password and identity links remain. Only an explicit administrator reactivation restores access."
              : "Allow this account to sign in again using its existing credentials. Previously revoked sessions stay signed out. Reactivation does not restore credentials or identity links cleared by removal."}
        </p>
        {account.hasActiveOidcIdentity ? (
          <p className="body-copy">
            {kind === "remove"
              ? "Linked identities will be retired permanently. Their issuer and subject remain reserved."
              : "This account is linked to an identity provider. This changes local access only; provider permissions still apply."}
          </p>
        ) : null}
        {account.activeAssignmentCount > 0 ? (
          <p className="body-copy">
            {account.activeAssignmentCount} active assignments remain recorded.
            Review and reassign this work in Administration assignments.
          </p>
        ) : null}
        <div className="field">
          <label htmlFor={id}>Reason (required)</label>
          <textarea
            id={id}
            ref={reasonRef}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            rows={3}
            disabled={pending}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${id}-error` : undefined}
          />
          {fieldError ? (
            <p id={`${id}-error`} className="field-error-message">
              {fieldError}
            </p>
          ) : null}
        </div>
        {error ? (
          <p
            className="field-error-message"
            role="alert"
            tabIndex={-1}
            ref={alertRef}
          >
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <button
            className="button button-primary"
            type="submit"
            disabled={pending}
          >
            {pending ? "Updating account..." : ACCOUNT_LIFECYCLE_LABELS[kind]}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
