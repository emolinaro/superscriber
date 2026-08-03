import { useId } from "react";

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const titleId = useId();

  return (
    <section aria-label={title} aria-labelledby={titleId} className="empty-state" role="status">
      <h2 className="empty-state__title" id={titleId}>
        {title}
      </h2>
      <p className="empty-state__description">{description}</p>
    </section>
  );
}
