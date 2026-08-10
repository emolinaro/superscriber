"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Pane heading for the two-door auth card. When a server-rendered notice
 * (session expired, forced re-login, bootstrap complete, ...) requests
 * heading focus, the VISIBLE pane's heading is the orienting target - same
 * role the pre-restyle AuthSurface heading played. Only the pane the server
 * chose carries `focusOnMount`, so focus never lands inside a hidden
 * tabpanel.
 */
export function AuthPaneHeading({
  focusOnMount = false,
  children,
}: {
  focusOnMount?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusOnMount) {
      ref.current?.focus();
    }
  }, [focusOnMount]);

  return (
    <h2 className="card-title auth-pane__title" ref={ref} tabIndex={-1}>
      {children}
    </h2>
  );
}
