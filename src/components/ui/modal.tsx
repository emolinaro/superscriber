"use client";

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const MODAL_STACK_BASE_Z_INDEX = 1000;
const modalStack: Array<{ backdrop: HTMLDivElement; id: symbol }> = [];
let modalDocumentState: {
  appRoot: HTMLElement | null;
  appRootWasInert: boolean;
  previousOverflow: string;
} | null = null;
const useModalLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function syncModalStack() {
  modalStack.forEach(({ backdrop }, index) => {
    const isTop = index === modalStack.length - 1;
    backdrop.style.zIndex = String(MODAL_STACK_BASE_Z_INDEX + index);
    backdrop.toggleAttribute("inert", !isTop);
    if (isTop) {
      backdrop.removeAttribute("aria-hidden");
    } else {
      backdrop.setAttribute("aria-hidden", "true");
    }
  });
}

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
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const stackIdRef = useRef(Symbol());
  const triggerRef = useRef<HTMLElement | null>(null);
  // Consumers pass inline onClose arrows, so the identity changes every
  // render. Without the ref, any re-render (e.g. per-keystroke state in a
  // dialog form) re-ran this effect and stole focus to the first focusable
  // control. The effect must key on `open` only; onClose travels via ref.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useModalLayoutEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    const appRoot = document.getElementById("app-root");
    const stackId = stackIdRef.current;
    const backdrop = backdropRef.current;
    if (!backdrop) {
      return;
    }
    if (modalStack.length === 0) {
      const appRootWasInert = appRoot?.hasAttribute("inert") ?? false;
      modalDocumentState = {
        appRoot,
        appRootWasInert,
        previousOverflow: document.body.style.overflow,
      };
      document.body.style.overflow = "hidden";
      if (appRoot && !appRootWasInert) {
        appRoot.setAttribute("inert", "");
      }
    }
    modalStack.push({ backdrop, id: stackId });
    syncModalStack();
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = dialogRef.current ? getFocusableElements(dialogRef.current) : [];
    // Corner Close is chrome, not a task control: initial focus belongs to
    // the first content control so keyboard users land on the actual work.
    const initialFocus =
      focusable.find((element) => !element.hasAttribute("data-modal-close")) ??
      focusable[0] ??
      dialogRef.current;
    initialFocus?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (!dialogRef.current || modalStack[modalStack.length - 1]?.id !== stackId) {
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
      const stackIndex = modalStack.findIndex((entry) => entry.id === stackId);
      const wasTop = stackIndex !== -1 && stackIndex === modalStack.length - 1;
      if (stackIndex !== -1) {
        modalStack.splice(stackIndex, 1);
      }
      syncModalStack();
      if (stackIndex !== -1 && modalStack.length === 0 && modalDocumentState) {
        document.body.style.overflow = modalDocumentState.previousOverflow;
        if (modalDocumentState.appRoot && !modalDocumentState.appRootWasInert) {
          modalDocumentState.appRoot.removeAttribute("inert");
        }
        modalDocumentState = null;
      }
      if (wasTop) {
        triggerRef.current?.focus();
      }
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
        if (
          modalStack[modalStack.length - 1]?.id === stackIdRef.current &&
          event.target === event.currentTarget
        ) {
          onCloseRef.current();
        }
      }}
      ref={backdropRef}
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
