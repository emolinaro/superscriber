import type { ReactNode } from "react";

type NoticeTone = "info" | "success" | "warning" | "danger";

export function InlineNotice({
  tone,
  children,
}: {
  tone: NoticeTone;
  children: ReactNode;
}) {
  return (
    <div className="inline-notice" data-tone={tone} role="status">
      <span aria-hidden="true" className="inline-notice__icon">
        {tone === "success" ? "✓" : tone === "warning" ? "!" : tone === "danger" ? "×" : "i"}
      </span>
      <span>{children}</span>
    </div>
  );
}
