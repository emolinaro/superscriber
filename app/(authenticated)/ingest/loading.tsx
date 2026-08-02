export default function Loading() {
  return (
    <div className="shell shell-wide stack ingest-shell">
      <section aria-label="Loading ingest" className="surface-intro surface-intro--ingest" role="status">
        <span className="sr-only">Loading ingest</span>
        <div className="surface-intro__copy stack-tight">
          <div aria-hidden="true" className="ingest-loading-block ingest-loading-block--eyebrow" />
          <div aria-hidden="true" className="ingest-loading-block ingest-loading-block--title" />
          <div aria-hidden="true" className="ingest-loading-block ingest-loading-block--copy" />
        </div>
      </section>
      <section aria-hidden="true" className="panel panel-strong">
        <div className="panel-inner stack ingest-loading-card">
          <div className="ingest-loading-block ingest-loading-block--title" />
          <div className="ingest-loading-grid">
            <div className="ingest-loading-block ingest-loading-block--field" />
            <div className="ingest-loading-block ingest-loading-block--field" />
            <div className="ingest-loading-block ingest-loading-block--field ingest-loading-block--field-large" />
          </div>
          <div className="ingest-loading-block ingest-loading-block--button" />
        </div>
      </section>
    </div>
  );
}
