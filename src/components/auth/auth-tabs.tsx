"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type AuthEntry = "signup" | "signin";

/**
 * Explicit first-run vs returning-user split for the auth landing page
 * (demo sign-in restyle, replayed onto the branded surface).
 *
 * Sign up = first-time persona admission (the first-admin ceremony, or the
 * admin-provisioned explanation once an envelope exists).
 * Sign in = returning user (institutional and/or local credentials).
 *
 * Renders as an APG tab pair: two visually distinct doors, one visible pane,
 * arrow-key navigation, and a labelled tabpanel each.
 */
export function AuthTabs({
  signUpPane,
  signInPane,
  initialEntry = "signin",
}: {
  signUpPane: ReactNode;
  signInPane: ReactNode;
  initialEntry?: AuthEntry;
}) {
  const [entry, setEntry] = useState<AuthEntry>(initialEntry);
  const baseId = useId();

  // Server-side re-renders (post-form navigations like bootstrap-complete)
  // keep this component instance alive; the server-chosen entry must win
  // again whenever it changes. Syncing during render (React's "adjust
  // state when a prop changes" pattern) instead of post-commit keeps
  // pane visibility and pane-heading focus in the same commit, so a
  // focusOnMount heading never fires while its tabpanel is still hidden.
  const [appliedInitialEntry, setAppliedInitialEntry] = useState(initialEntry);
  if (appliedInitialEntry !== initialEntry) {
    setAppliedInitialEntry(initialEntry);
    setEntry(initialEntry);
  }

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const entries: Array<{ key: AuthEntry; label: string }> = [
    { key: "signup", label: "Sign up" },
    { key: "signin", label: "Sign in" },
  ];

  // eslint-disable-next-line react-hooks/exhaustive-deps -- entries is a stable per-render literal
  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
        return;
      }
      event.preventDefault();
      const nextIndex =
        event.key === "ArrowRight"
          ? (index + 1) % entries.length
          : (index + entries.length - 1) % entries.length;
      const next = entries[nextIndex];
      setEntry(next.key);
      tabRefs.current[nextIndex]?.focus();
    },
    [],
  );

  return (
    <div className="auth-tabs">
      <div aria-label="Account access" className="auth-tabs__list" role="tablist">
        {entries.map((tab, index) => {
          const selected = entry === tab.key;
          return (
            <button
              aria-controls={`${baseId}-panel-${tab.key}`}
              aria-selected={selected}
              className="auth-tabs__tab"
              data-selected={selected}
              id={`${baseId}-tab-${tab.key}`}
              key={tab.key}
              onClick={() => setEntry(tab.key)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`${baseId}-tab-signup`}
        className="auth-tabs__panel"
        hidden={entry !== "signup"}
        id={`${baseId}-panel-signup`}
        role="tabpanel"
      >
        {signUpPane}
      </div>
      <div
        aria-labelledby={`${baseId}-tab-signin`}
        className="auth-tabs__panel"
        hidden={entry !== "signin"}
        id={`${baseId}-panel-signin`}
        role="tabpanel"
      >
        {signInPane}
      </div>
    </div>
  );
}
