"use client";

import Link from "next/link";

export default function AuthenticatedError({
  error,
  reset,
}: {
  error: Error & { digest?: string; correlationId?: string };
  reset: () => void;
}) {
  return (
    <main className="shell shell-wide workspace-shell">
      <section className="surface-intro stack">
        <div>
          <p className="surface-intro__eyebrow">Workspace</p>
          <h1 className="surface-intro__title">Superscriber could not load this page.</h1>
          <p className="surface-intro__description">
            Your saved server data was not changed.
          </p>
          {error.correlationId ? <p className="field-note">Reference: {error.correlationId}</p> : null}
        </div>
        <div className="button-row">
          <button className="button button-primary" onClick={() => reset()} type="button">
            Retry
          </button>
          <Link className="button button-secondary" href="/workspace">
            Back to Work
          </Link>
        </div>
      </section>
    </main>
  );
}
