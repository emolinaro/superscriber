"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("hidden") && !element.getAttribute("aria-hidden"),
  );
}

export function Modal({
  open,
  title,
  description,
  children,
  onClose,
  backdropClassName,
  backdropTestId,
  surfaceClassName,
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  backdropClassName?: string;
  backdropTestId?: string;
  surfaceClassName?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Consumers pass inline onClose arrows, so the identity changes every
  // render. Without the ref, any re-render (e.g. per-keystroke state in a
  // dialog form) re-ran this effect and stole focus to the first focusable
  // control. The effect must key on `open` only; onClose travels via ref.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    const appRoot = document.getElementById("app-root");
    const previousOverflow = document.body.style.overflow;
    const wasInert = appRoot?.hasAttribute("inert") ?? false;
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    document.body.style.overflow = "hidden";
    if (appRoot && !wasInert) {
      appRoot.setAttribute("inert", "");
    }

    const focusable = dialogRef.current ? getFocusableElements(dialogRef.current) : [];
    // Corner Close is chrome, not a task control: initial focus belongs to
    // the first content control so keyboard users land on the actual work.
    const initialFocus =
      focusable.find((element) => !element.hasAttribute("data-modal-close")) ??
      focusable[0] ??
      dialogRef.current;
    initialFocus?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (!dialogRef.current) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const currentFocusable = getFocusableElements(dialogRef.current);
      if (currentFocusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = currentFocusable[0];
      const last = currentFocusable[currentFocusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (appRoot && !wasInert) {
        appRoot.removeAttribute("inert");
      }
      triggerRef.current?.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className={backdropClassName ? `modal-backdrop ${backdropClassName}` : "modal-backdrop"}
      data-testid={backdropTestId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCloseRef.current();
        }
      }}
    >
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={surfaceClassName ? `modal-surface ${surfaceClassName}` : "modal-surface"}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modal-header">
          <div className="modal-header__copy">
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="modal-description" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          {/* Shared chrome corner Close on every dialog; Escape/backdrop
              unchanged. */}
          <button
            aria-label="Close dialog"
            className="modal-close interactive-target"
            data-modal-close
            onClick={() => onCloseRef.current()}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
