"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import {
  adminPasswordResetInputSchema,
  PASSWORD_RESET_ADMIN_COPY,
  type AdminPasswordResetInput,
} from "@/lib/account-password-reset";
import type { AdminPasswordResetActionResult } from "@/server/actions/administration-actions";
import { clearSelfResetHold, markSelfResetHold } from "@/lib/self-reset-hold";

type Stage =
  | { kind: "form" }
  | {
      kind: "issued";
      resetUrl: string | null;
      expiresAt: string;
      notice: string;
      actorMustRelogin: boolean;
    };

/**
 * Governed password reset modal (spec section 5). Exactly one disclosure
 * channel: the link is revealed once (handoff) or emailed without reveal.
 */
export function AccountPasswordResetModal({
  account,
  currentUserId,
  resetMailConfigured,
  onClose,
  onIssued,
  action,
}: {
  account: { id: string; displayName: string };
  currentUserId: string;
  resetMailConfigured: boolean;
  onClose: () => void;
  onIssued: () => void;
  action: (input: AdminPasswordResetInput) => Promise<AdminPasswordResetActionResult>;
}) {
  const reasonId = useId();
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [reason, setReason] = useState("");
  const [delivery, setDelivery] = useState<AdminPasswordResetInput["delivery"]>(
    "operator_handoff",
  );
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();
  const mountedRef = useRef(true);
  const resetHoldOwnedRef = useRef(false);

  const isSelf = account.id === currentUserId;

  function releaseResetHold() {
    if (resetHoldOwnedRef.current) {
      clearSelfResetHold();
      resetHoldOwnedRef.current = false;
    }
  }

  // A self-reset hold never outlives this dialog: if the modal unmounts for
  // any reason, the session guard resumes guarding.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseResetHold();
    };
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) {
      return;
    }
    setFieldError(null);
    setFormError(null);

    const parsed = adminPasswordResetInputSchema.safeParse({
      userId: account.id,
      reason,
      delivery: isSelf ? "operator_handoff" : delivery,
    });
    if (!parsed.success) {
      releaseResetHold();
      setFieldError(parsed.error.flatten().fieldErrors.reason?.[0] ?? "Check the form.");
      return;
    }

    markSelfResetHold();
    resetHoldOwnedRef.current = true;

    startTransition(async () => {
      let result: AdminPasswordResetActionResult;
      try {
        result = await action(parsed.data);
      } catch {
        if (mountedRef.current) {
          releaseResetHold();
          setFormError(PASSWORD_RESET_ADMIN_COPY.INTERNAL_ERROR);
        }
        return;
      }
      if (!mountedRef.current) {
        return;
      }
      if (!result.ok) {
        releaseResetHold();
        if (result.fieldErrors?.reason) {
          setFieldError(result.fieldErrors.reason);
        } else {
          setFormError(result.message);
        }
        return;
      }
      const actorMustRelogin = result.data.actorMustRelogin;
      if (!actorMustRelogin) {
        releaseResetHold();
      }
      setStage({
        kind: "issued",
        resetUrl: result.data.resetUrl,
        expiresAt: result.data.expiresAt,
        notice: result.notice,
        actorMustRelogin,
      });
      if (!actorMustRelogin) {
        onIssued();
      }
    });
  }

  function close() {
    const mustRelogin = stage.kind === "issued" && stage.actorMustRelogin;
    releaseResetHold();
    setStage({ kind: "form" });
    onClose();
    if (mustRelogin) {
      onIssued();
    }
  }

  return (
    <Modal onClose={close} open title={`Reset password for ${account.displayName}`}>
      {stage.kind === "issued" ? (
        <div className="stack" role="status">
          <p>{stage.notice}</p>
          {stage.resetUrl ? (
            <>
              <p>
                This single-use link is shown exactly once. It expires at {stage.expiresAt}.
                Deliver it to {account.displayName} out-of-band.
              </p>
              <div className="field">
                <label htmlFor="reset-reveal-url">Reset link</label>
                <input id="reset-reveal-url" readOnly type="text" value={stage.resetUrl} />
              </div>
              <button
                className="button button-secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(stage.resetUrl ?? "");
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
                type="button"
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </>
          ) : (
            <p>The reset link was emailed. It expires at {stage.expiresAt}.</p>
          )}
          {stage.actorMustRelogin ? (
            stage.resetUrl ? (
              <p className="body-copy" role="note">
                Copy this link now. Closing this dialog signs you out; open the
                link while signed out (or in a private window) to finish.
              </p>
            ) : (
              <p className="body-copy" role="note">
                Closing this dialog signs you out; use the emailed link while
                signed out (or in a private window) to finish.
              </p>
            )
          ) : null}
          <div className="button-row">
            <button className="button button-primary" onClick={close} type="button">
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="form-grid" noValidate onSubmit={handleSubmit}>
          {formError ? (
            <div className="error-summary" role="alert">
              <p>{formError}</p>
            </div>
          ) : null}
          {isSelf ? (
            <p className="body-copy" role="note">
              You are resetting your own password. This signs YOU out everywhere
              (including this session) the moment you close the result dialog.
            </p>
          ) : null}
          <p className="body-copy">
            Issuing a reset signs {account.displayName} out everywhere and
            cancels any reset already in progress.
          </p>
          <div className="field">
            <label htmlFor={reasonId}>Reason (required)</label>
            <textarea
              id={reasonId}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              value={reason}
            />
            {fieldError ? (
              <p className="field-error" role="alert">
                {fieldError}
              </p>
            ) : null}
          </div>
          {isSelf ? (
            <>
              <p className="body-copy">
                Resetting your own account signs you out; copy the link from this
                dialog - email delivery is unavailable for your own account.
              </p>
              {resetMailConfigured ? null : (
                <p className="body-copy">
                  Email delivery is not configured on this appliance. The reset link
                  is shown once here - copy it and hand it over directly.
                </p>
              )}
            </>
          ) : resetMailConfigured ? (
            <fieldset className="field">
              <legend>Delivery</legend>
              <label>
                <input
                  checked={delivery === "operator_handoff"}
                  name="delivery"
                  onChange={() => setDelivery("operator_handoff")}
                  type="radio"
                  value="operator_handoff"
                />{" "}
                Out-of-band handoff (show the link once)
              </label>
              <label>
                <input
                  checked={delivery === "email"}
                  name="delivery"
                  onChange={() => setDelivery("email")}
                  type="radio"
                  value="email"
                />{" "}
                Email the reset link
              </label>
            </fieldset>
          ) : (
            <p className="body-copy">
              Email delivery is not configured on this appliance. The reset link
              is shown once here - copy it and hand it over directly.
            </p>
          )}
          <div className="button-row">
            <button className="button button-primary" disabled={isPending} type="submit">
              {isPending ? "Issuing..." : "Issue reset"}
            </button>
            <button className="button button-secondary" onClick={close} type="button">
              Cancel
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
