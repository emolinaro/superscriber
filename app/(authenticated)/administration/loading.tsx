import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return (
    <div className="shell shell-wide stack administration-shell">
      <PageSkeleton layout="administration" surface="administration" />
    </div>
  );
}
