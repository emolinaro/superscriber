export default function Loading() {
  return (
    <div className="shell shell-wide workspace-shell">
      <section aria-label="Loading work inbox" className="work-loading" role="status">
        <span className="sr-only">Loading work inbox</span>
        <div aria-hidden="true" className="work-loading__block work-loading__block--eyebrow" />
        <div aria-hidden="true" className="work-loading__block work-loading__block--title" />
        <div aria-hidden="true" className="work-loading__block work-loading__block--copy" />
        <div aria-hidden="true" className="work-loading__tabs">
          <span className="work-loading__chip" />
          <span className="work-loading__chip" />
          <span className="work-loading__chip" />
        </div>
        <div aria-hidden="true" className="work-loading__filters">
          <span className="work-loading__field" />
          <span className="work-loading__field" />
          <span className="work-loading__field" />
          <span className="work-loading__field" />
        </div>
        <div aria-hidden="true" className="work-loading__row" />
        <div aria-hidden="true" className="work-loading__row" />
        <div aria-hidden="true" className="work-loading__row" />
      </section>
    </div>
  );
}
