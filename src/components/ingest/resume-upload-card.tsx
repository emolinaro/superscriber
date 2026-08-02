export function ResumeUploadCard({
  tone,
  message,
}: {
  tone: "info" | "warning";
  message: string;
}) {
  return (
    <section className="ingest-resume-card inline-notice" data-tone={tone} role="status">
      <span aria-hidden="true" className="inline-notice__icon">
        {tone === "warning" ? "!" : "i"}
      </span>
      <span>{message}</span>
    </section>
  );
}
