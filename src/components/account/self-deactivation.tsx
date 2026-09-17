"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { signOut } from "next-auth/react";
import { Modal } from "@/components/ui/modal";
import { accountReasonSchema } from "@/lib/account-lifecycle";
import {
  markIntentionalSignOut,
  clearIntentionalSignOut,
} from "@/lib/signed-out-marker";
import { deactivateOwnAccountAction } from "@/server/actions/account-lifecycle-actions";

export function SelfDeactivation({
  userId,
  action = deactivateOwnAccountAction,
}: {
  userId: string;
  action?: typeof deactivateOwnAccountAction;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alertRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setError(null);
    const parsed = accountReasonSchema.safeParse(reason);
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    busy.current = true;
    setPending(true);
    markIntentionalSignOut();
    let committed = false;
    try {
      const result = await action({
        expectedActorUserId: userId,
        reason: parsed.data,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      committed = true;
      await signOut({
        callbackUrl: "/?reason=account-deactivated",
        redirect: true,
      });
    } catch {
      if (committed) window.location.assign("/?reason=account-deactivated");
      else
        setError(
          "Deactivation could not be confirmed. Refresh to check your account state.",
        );
    } finally {
      if (!committed) clearIntentionalSignOut();
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <>
      <button
        className="button button-secondary"
        type="button"
        onClick={() => {
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        Deactivate my account
      </button>
      <Modal
        open={open}
        title="Deactivate your account"
        onClose={() => {
          if (!busy.current) setOpen(false);
        }}
      >
        <form className="form-grid" noValidate onSubmit={submit}>
          <p className="body-copy">
            This signs you out everywhere and deactivates your account. You can
            restore access by signing in again with valid credentials. Accounts
            deactivated by an administrator require administrator reactivation
            instead.
          </p>
          <p className="body-copy">
            Your account record, assignments, and governed history remain. The
            last active administrator and break-glass custodian cannot
            deactivate themselves.
          </p>
          <div className="field">
            <label htmlFor={id}>Reason (required)</label>
            <textarea
              id={id}
              rows={3}
              maxLength={500}
              value={reason}
              disabled={pending}
              onChange={(event) => setReason(event.target.value)}
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
              {pending ? "Deactivating..." : "Deactivate and sign out"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={pending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
