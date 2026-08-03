"use client";

export default function RootError({
  reset,
}: {
  error: Error & { digest?: string; correlationId?: string };
  reset: () => void;
}) {
  return (
    <main className="shell shell-auth">
      <section className="surface-intro stack">
        <div>
          <p className="surface-intro__eyebrow">Authentication</p>
          <h1 className="surface-intro__title">Superscriber could not load sign-in.</h1>
          <p className="surface-intro__description">
            Retry the page. No credentials were saved.
          </p>
        </div>
        <div className="button-row">
          <button className="button button-primary" onClick={() => reset()} type="button">
            Retry
          </button>
        </div>
      </section>
    </main>
  );
}
