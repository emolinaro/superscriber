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
    (focusable[0] ?? dialogRef.current)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (!dialogRef.current) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
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
  }, [open, onClose]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className={backdropClassName ? `modal-backdrop ${backdropClassName}` : "modal-backdrop"}
      data-testid={backdropTestId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
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
          <h2 className="modal-title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="modal-description" id={descriptionId}>
              {description}
            </p>
          ) : null}
        </div>
        <div className="modal-content">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
