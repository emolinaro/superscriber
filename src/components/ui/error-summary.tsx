"use client";

import { useEffect, useId, useRef } from "react";

export type ErrorSummaryItem = {
  fieldId: string;
  label: string;
  message: string;
};

export function ErrorSummary({
  title = "There is a problem",
  errors,
}: {
  title?: string;
  errors: ErrorSummaryItem[];
}) {
  const headingId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // `errors` is rebuilt per render by callers (new array identity every
  // keystroke while live-editing around a failed submit). Focus must fire
  // only when the error SET changed - otherwise each keystroke steals focus
  // from the field being typed in.
  const lastSignatureRef = useRef<string | null>(null);
  const signature = errors.map((error) => `${error.fieldId}:${error.message}`).join("|");

  useEffect(() => {
    if (errors.length > 0 && signature !== lastSignatureRef.current) {
      ref.current?.focus();
    }
    lastSignatureRef.current = signature;
  }, [errors, signature]);

  if (errors.length === 0) {
    return null;
  }

  return (
    <div
      ref={ref}
      aria-label={title}
      aria-labelledby={headingId}
      className="error-summary"
      role="alert"
      tabIndex={-1}
    >
      <h2 className="error-summary__title" id={headingId}>
        {title}
      </h2>
      <ul className="error-summary__list">
        {errors.map((error) => (
          <li key={`${error.fieldId}-${error.message}`}>
            <a
              className="error-summary__link interactive-target"
              href={`#${error.fieldId}`}
              onClick={(event) => {
                const target = document.getElementById(error.fieldId);
                if (!target) {
                  return;
                }

                event.preventDefault();
                target.focus();
              }}
            >
              {error.label} - {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
