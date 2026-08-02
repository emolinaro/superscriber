import { PageSkeleton } from "@/components/ui/page-skeleton";

export default function Loading() {
  return (
    <main className="shell shell-auth">
      <PageSkeleton surface="sign in" />
    </main>
  );
}
