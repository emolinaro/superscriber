import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return (
    <main className="shell shell-auth">
      <PageSkeleton layout="auth" surface="authentication" />
    </main>
  );
}
