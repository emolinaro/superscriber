import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return (
    <div className="shell shell-wide stack ingest-shell">
      <PageSkeleton layout="ingest" surface="ingest" />
    </div>
  );
}
