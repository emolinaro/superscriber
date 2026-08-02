"use client";

export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="shell shell-auth">
      <section className="surface-intro stack">
        <div>
          <p className="surface-intro__eyebrow">Authentication</p>
          <h1 className="surface-intro__title">The sign-in page could not be loaded safely.</h1>
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
