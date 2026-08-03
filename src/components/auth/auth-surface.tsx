"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function AuthSurface({
  children,
  description,
  focusHeading = false,
  heading,
  notice,
  support = null,
}: {
  children: ReactNode;
  description: string;
  focusHeading?: boolean;
  heading: string;
  notice?: {
    tone: "ok" | "danger";
    message: string;
  };
  support?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusHeading) {
      headingRef.current?.focus();
    }
  }, [focusHeading]);

  return (
    <div className="auth-surface">
      <section className="auth-surface__primary panel panel-strong">
        <div className="panel-inner stack auth-surface__primary-inner">
          <div className="stack-tight">
            <h1 className="section-title auth-surface__heading" ref={headingRef} tabIndex={-1}>
              {heading}
            </h1>
            <p className="body-copy">{description}</p>
          </div>
          {notice ? (
            <p className="banner" data-tone={notice.tone} role={notice.tone === "danger" ? "alert" : "status"}>
              {notice.message}
            </p>
          ) : null}
          {children}
        </div>
      </section>
      <aside className="auth-surface__support panel panel-subtle">
        <div className="panel-inner stack-tight">{support}</div>
      </aside>
    </div>
  );
}
