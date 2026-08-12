"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { AuthEntry } from "@/lib/auth-entry";

export type { AuthEntry };

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
 *
 * Progressive enhancement: each door is a real link to `/?entry=signup` /
 * `/?entry=signin`, so the doors work with zero JavaScript (the server
 * renders the requested pane). Once hydrated, unmodified primary clicks are
 * intercepted and toggled client-side instantly, with no navigation.
 */
export function AuthTabs({
  signUpPane,
  signInPane,
  signUpHref,
  signInHref,
  initialEntry = "signin",
}: {
  signUpPane: ReactNode;
  signInPane: ReactNode;
  signUpHref: string;
  signInHref: string;
  initialEntry?: AuthEntry;
}) {
  const [entry, setEntry] = useState<AuthEntry>(initialEntry);
  const [isHydrated, setIsHydrated] = useState(false);
  const baseId = useId();

  useEffect(() => {
    setIsHydrated(true);
  }, []);

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

  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const entries: Array<{ key: AuthEntry; label: string; href: string }> = [
    { key: "signup", label: "Sign up", href: signUpHref },
    { key: "signin", label: "Sign in", href: signInHref },
  ];

  // Post-hydration the doors toggle instantly in place; the href remains the
  // no-JS and modified-activation fallback.
  const onTabClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, key: AuthEntry) => {
      if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      setEntry(key);
    },
    [],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- entries is a stable per-render literal
  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const nextIndex =
          event.key === "ArrowRight"
            ? (index + 1) % entries.length
            : (index + entries.length - 1) % entries.length;
        const next = entries[nextIndex];
        setEntry(next.key);
        tabRefs.current[nextIndex]?.focus();
        return;
      }
      // Anchors only fire click on Enter; Space keeps the toggle contract
      // the doors had as buttons without following the href.
      if (event.key === " ") {
        event.preventDefault();
        setEntry(entries[index].key);
      }
    },
    [],
  );

  return (
    <div className="auth-tabs">
      <div aria-label="Account access" className="auth-tabs__list" role="tablist">
        {entries.map((tab, index) => {
          const selected = entry === tab.key;
          return (
            <a
              aria-controls={`${baseId}-panel-${tab.key}`}
              aria-selected={selected}
              className="auth-tabs__tab"
              data-selected={selected}
              href={tab.href}
              id={`${baseId}-tab-${tab.key}`}
              key={tab.key}
              onClick={(event) => onTabClick(event, tab.key)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              role="tab"
              tabIndex={isHydrated ? (selected ? 0 : -1) : undefined}
            >
              {tab.label}
            </a>
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
