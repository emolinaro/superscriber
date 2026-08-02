import Link from "next/link";
import type { UserRole } from "@/domain/models";
import type { WorkInboxViewModel } from "@/server/work-inbox/service";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { RecordingLedger } from "./recording-ledger";
import { WorkFilters } from "./work-filters";

const EMPTY_COPY: Record<UserRole, Record<string, string>> = {
  uploader: {
    "my-uploads": "No uploads are in this view.",
    "needs-attention": "No uploads are in this view.",
    processing: "No uploads are in this view.",
    ready: "No uploads are in this view.",
  },
  reviewer: {
    "to-review": "No transcript review is assigned to you.",
    waiting: "No transcript review is assigned to you.",
    completed: "No transcript review is assigned to you.",
  },
  approver: {
    "to-decide": "No approval decision is assigned to you.",
    waiting: "No approval decision is assigned to you.",
    completed: "No approval decision is assigned to you.",
  },
  admin: {
    all: "No recordings are in this view.",
    "needs-attention": "No recordings are in this view.",
    review: "No recordings are in this view.",
    approval: "No recordings are in this view.",
    approved: "No recordings are in this view.",
  },
};

function toneForStage(stage: WorkInboxViewModel["rows"][number]["stage"]) {
  if (stage === "approved") {
    return "success" as const;
  }

  if (stage === "pending_approval" || stage === "verifying" || stage === "reopened") {
    return "warning" as const;
  }

  if (stage === "needs_ingest_attention" || stage === "changes_requested") {
    return "danger" as const;
  }

  return "info" as const;
}

function emptyCopy(model: WorkInboxViewModel) {
  return EMPTY_COPY[model.role][model.filters.tab] ?? EMPTY_COPY[model.role][model.tabs[0]!.id]!;
}

export function WorkInbox({ model }: { model: WorkInboxViewModel }) {
  return (
    <div className="work-page">
      <section className="surface-intro work-intro">
        <p className="surface-intro__eyebrow">Work inbox</p>
        <h1 className="surface-intro__title">{model.heading}</h1>
        <p className="surface-intro__description">{model.responsibility}</p>
      </section>

      <nav aria-label="Work status" className="work-tabs">
        <ul className="work-tabs__list">
          {model.tabs.map((tab) => (
            <li key={tab.id}>
              <Link
                aria-current={tab.isActive ? "page" : undefined}
                aria-label={`${tab.label} ${tab.count}`}
                className="work-tabs__link interactive-target"
                href={tab.href}
              >
                <span>{tab.label}</span>
                <span className="work-tabs__count">{tab.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <WorkFilters filters={model.filters} resultCount={model.rows.length} role={model.role} />

      {model.nextAction ? (
        <section aria-label="Next action" className="work-next-action">
          <div className="work-next-action__copy">
            <p className="work-next-action__eyebrow">Next action</p>
            <h2 className="work-next-action__title">{model.nextAction.title}</h2>
            <div className="work-next-action__meta">
              <StatusBadge tone={toneForStage(model.nextAction.stage)}>
                {model.nextAction.stageLabel}
              </StatusBadge>
              <span className="work-chip">{model.nextAction.assignmentLabel}</span>
              <time dateTime={model.nextAction.updatedAtIso}>{model.nextAction.updatedAtLabel}</time>
            </div>
          </div>
          <Link className="recording-action interactive-target" href={model.nextAction.href}>
            {model.nextAction.actionLabel ?? "Open record"}
          </Link>
        </section>
      ) : null}

      {model.rows.length > 0 ? (
        <section aria-labelledby="recording-ledger-title" className="work-ledger">
          <div className="work-ledger__header">
            <h2 className="work-ledger__title" id="recording-ledger-title">
              Recording ledger
            </h2>
          </div>
          <RecordingLedger role={model.role} rows={model.rows} />
        </section>
      ) : (
        <EmptyState
          description="Adjust the filters or switch tabs to inspect another governed view."
          title={emptyCopy(model)}
        />
      )}
    </div>
  );
}
