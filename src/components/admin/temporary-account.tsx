"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { USER_ROLES } from "@/domain/models";
import { formatRoleLabel } from "@/lib/format";
import {
  temporaryAccountInputSchema,
  type TemporaryAccountInput,
} from "@/lib/account-lifecycle";
import { createTemporaryAccountAction } from "@/server/actions/administration-actions";
import type { AccountDirectoryEntry } from "@/server/access/service";

export function TemporaryAccountModal({
  currentUserId,
  onClose,
  onCreated,
  action = createTemporaryAccountAction,
}: {
  currentUserId: string;
  onClose: () => void;
  onCreated: (user: AccountDirectoryEntry) => void;
  action?: typeof createTemporaryAccountAction;
}) {
  const id = useId();
  const [values, setValues] = useState<TemporaryAccountInput>({
    displayName: "",
    email: "",
    role: "reviewer",
    reason: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    password: string;
    displayName: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (issued) passwordRef.current?.focus();
  }, [issued]);
  function close() {
    if (busy.current) return;
    setIssued(null);
    onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setError(null);
    const parsed = temporaryAccountInputSchema.safeParse(values);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form.");
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
      setIssued({
        password: result.data.temporaryPassword,
        displayName: result.data.user.displayName,
      });
      onCreated(result.data.user);
    } catch {
      if (mounted.current)
        setError(
          "Account creation could not be confirmed. Check the account list before retrying. If it was created, use Reset password to issue a new handoff.",
        );
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <Modal open title="Create account with temporary password" onClose={close}>
      {issued ? (
        <div className="stack">
          <p role="status">Account created for {issued.displayName}.</p>
          <p className="body-copy">
            This password is shown once, until you close this dialog. Deliver it
            directly to the account holder. It expires at first sign-in, when the
            account holder must choose a new password before normal access.
          </p>
          <div className="field">
            <label htmlFor={`${id}-password`}>Temporary password</label>
            <input
              id={`${id}-password`}
              ref={passwordRef}
              readOnly
              autoComplete="off"
              value={issued.password}
            />
          </div>
          <div className="button-row">
            <button
              className="button button-secondary"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued.password);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy password"}
            </button>
            <button
              className="button button-primary"
              type="button"
              onClick={close}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="form-grid" noValidate onSubmit={submit}>
          <p className="body-copy">
            Generate a password on this appliance and hand it to the account
            holder. The password appears once after creation.
          </p>
          {(
            [
              ["displayName", "Name"],
              ["email", "Email"],
            ] as const
          ).map(([field, label]) => (
            <div className="field" key={field}>
              <label htmlFor={`${id}-${field}`}>{label}</label>
              <input
                id={`${id}-${field}`}
                type={field === "email" ? "email" : "text"}
                required
                disabled={pending}
                value={values[field]}
                onChange={(event) =>
                  setValues({ ...values, [field]: event.target.value })
                }
              />
            </div>
          ))}
          <div className="field">
            <label htmlFor={`${id}-role`}>Role</label>
            <select
              id={`${id}-role`}
              disabled={pending}
              value={values.role}
              onChange={(event) =>
                setValues({
                  ...values,
                  role: event.target.value as TemporaryAccountInput["role"],
                })
              }
            >
              {USER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {formatRoleLabel(role)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-reason`}>Reason (required)</label>
            <textarea
              id={`${id}-reason`}
              maxLength={500}
              rows={3}
              required
              disabled={pending}
              value={values.reason}
              onChange={(event) =>
                setValues({ ...values, reason: event.target.value })
              }
            />
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
              {pending ? "Creating account..." : "Create account"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={pending}
              onClick={close}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
