type PageSkeletonLayout = "auth" | "work" | "ingest" | "casefile" | "administration";

function layoutForSurface(surface: string): PageSkeletonLayout {
  if (surface === "authentication") {
    return "auth";
  }

  if (surface === "work inbox") {
    return "work";
  }

  if (surface === "ingest") {
    return "ingest";
  }

  if (surface === "administration") {
    return "administration";
  }

  return "casefile";
}

export function PageSkeleton({
  surface,
  layout = layoutForSurface(surface),
}: {
  surface: string;
  layout?: PageSkeletonLayout;
}) {
  return (
    <section
      aria-label={`Loading ${surface}`}
      aria-live="polite"
      className={`page-skeleton page-skeleton--${layout}`}
      role="status"
    >
      <span className="sr-only">Loading {surface}</span>
      <div aria-hidden="true" className="page-skeleton__block page-skeleton__block--eyebrow" />
      <div aria-hidden="true" className="page-skeleton__block page-skeleton__block--title" />
      <div aria-hidden="true" className="page-skeleton__block page-skeleton__block--copy" />
      <div aria-hidden="true" className="page-skeleton__block page-skeleton__block--copy page-skeleton__block--copy-short" />
      <div aria-hidden="true" className="page-skeleton__block page-skeleton__block--large" />
    </section>
  );
}
