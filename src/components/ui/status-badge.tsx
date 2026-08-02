import type { ReactNode } from "react";

type StatusTone = "info" | "success" | "warning" | "danger";

export function StatusBadge({
  tone,
  children,
}: {
  tone: StatusTone;
  children: ReactNode;
}) {
  return (
    <span className="status-badge" data-tone={tone}>
      <span aria-hidden="true" className="status-badge__icon">
        {tone === "success" ? "✓" : tone === "warning" ? "!" : tone === "danger" ? "×" : "i"}
      </span>
      <span className="status-badge__text">{children}</span>
    </span>
  );
}
