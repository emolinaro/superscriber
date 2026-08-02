export default function Loading() {
  return (
    <div className="shell shell-wide stack administration-shell">
      <section aria-label="Loading administration" className="surface-intro surface-intro--administration" role="status">
        <span className="sr-only">Loading administration</span>
        <div className="surface-intro__copy stack-tight">
          <div aria-hidden="true" className="administration-loading-block administration-loading-block--eyebrow" />
          <div aria-hidden="true" className="administration-loading-block administration-loading-block--title" />
          <div aria-hidden="true" className="administration-loading-block administration-loading-block--copy" />
        </div>
      </section>
      <section aria-hidden="true" className="panel panel-strong">
        <div className="panel-inner stack administration-loading-card">
          <div className="administration-loading-block administration-loading-block--row" />
          <div className="administration-loading-block administration-loading-block--row" />
          <div className="administration-loading-block administration-loading-block--row" />
        </div>
      </section>
    </div>
  );
}
