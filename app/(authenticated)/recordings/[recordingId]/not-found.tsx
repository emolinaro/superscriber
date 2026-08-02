import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <div className="casefile-page">
      <EmptyState
        description="Return to Work to open another governed recording."
        title="Casefile not found"
      />
      <div className="button-row">
        <Link className="button button-primary" href="/workspace">
          Back to Work
        </Link>
      </div>
    </div>
  );
}
