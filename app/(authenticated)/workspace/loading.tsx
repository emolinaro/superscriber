import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return (
    <div className="shell shell-wide workspace-shell">
      <PageSkeleton layout="work" surface="work inbox" />
    </div>
  );
}
