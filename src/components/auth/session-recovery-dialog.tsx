"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { signIn } from "next-auth/react";
import { Modal } from "@/components/ui/modal";

export function SessionRecoveryDialog({
  onClose,
  onRecovered,
  open,
}: {
  onClose: () => void;
  onRecovered: () => void;
  open: boolean;
}) {
  const summaryHeadingId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (error) {
      summaryRef.current?.focus();
    }
  }, [error]);

  function clearPassword() {
    if (passwordRef.current) {
      passwordRef.current.value = "";
    }
  }

  return (
    <Modal
      description="Re-enter your local account credentials to continue without losing the page state already in memory."
      onClose={onClose}
      open={open}
      title="Session expired"
    >
      <form
        className="form-grid auth-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (isPending) {
            return;
          }

          const formData = new FormData(event.currentTarget);
          const email = String(formData.get("email") ?? "").trim();
          const password = String(formData.get("password") ?? "");
          setError(null);

          startTransition(async () => {
            let result:
              | {
                  error?: string | null;
                  ok?: boolean;
                }
              | undefined;

            try {
              result = await signIn("credentials", {
                email,
                password,
                redirect: false,
              });
            } catch {
              result = undefined;
            }

            if (!result || result.error || result.ok === false) {
              clearPassword();
              setError("Session recovery failed. Your password was not saved. Try again.");
              passwordRef.current?.focus();
              return;
            }

            clearPassword();
            onRecovered();
          });
        }}
      >
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
          <label className="field-label" htmlFor="session-recovery-email">
            Email
          </label>
          <input
            autoComplete="email"
            id="session-recovery-email"
            name="email"
            required
            type="email"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="session-recovery-password">
            Password
          </label>
          <input
            autoComplete="current-password"
            id="session-recovery-password"
            name="password"
            ref={passwordRef}
            required
            type="password"
          />
        </div>

        <div className="button-row">
          <button className="button button-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="button button-primary" disabled={isPending} type="submit">
            {isPending ? "Recovering..." : "Recover session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
