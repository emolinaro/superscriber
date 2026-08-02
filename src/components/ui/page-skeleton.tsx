export function PageSkeleton({ surface }: { surface: string }) {
  return (
    <section aria-label={`Loading ${surface}`} className="page-skeleton" role="status">
      <span className="sr-only">Loading {surface}</span>
      <div aria-hidden="true" className="page-skeleton__block page-skeleton__block--title" />
      <div aria-hidden="true" className="page-skeleton__block" />
      <div aria-hidden="true" className="page-skeleton__block" />
      <div aria-hidden="true" className="page-skeleton__block page-skeleton__block--large" />
    </section>
  );
}
