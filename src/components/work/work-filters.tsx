"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CASEFILE_WORKFLOW_STAGES, type CasefileWorkflowStage } from "@/domain/casefile";
import type { RecordingSource, UserRole } from "@/domain/models";
import type { WorkInboxFilters } from "@/server/work-inbox/service";

const DEFAULT_TAB: Record<UserRole, string> = {
  uploader: "my-uploads",
  reviewer: "to-review",
  approver: "to-decide",
  admin: "all",
};

const STAGE_LABELS: Record<CasefileWorkflowStage, string> = {
  needs_ingest_attention: "Needs ingest attention",
  verifying: "Verifying",
  transcribing: "Transcribing",
  pending_approval: "Pending approval",
  approved: "Approved",
  changes_requested: "Changes requested",
  reopened: "Reopened",
  draft_review: "Draft review",
};

const SOURCE_OPTIONS: Array<{ value: RecordingSource; label: string }> = [
  { value: "upload", label: "Upload" },
  { value: "record", label: "Record" },
];

const SORT_OPTIONS: Array<{ value: WorkInboxFilters["sort"]; label: string }> = [
  { value: "default", label: "Default order" },
  { value: "updated_desc", label: "Updated - newest first" },
  { value: "updated_asc", label: "Updated - oldest first" },
];

type FilterFormState = {
  query: string;
  stage: string;
  source: string;
  assignmentUserId: string;
  sort: WorkInboxFilters["sort"];
};

function toFormState(filters: WorkInboxFilters): FilterFormState {
  return {
    query: filters.query,
    stage: filters.stage ?? "",
    source: filters.source ?? "",
    assignmentUserId: filters.assignmentUserId ?? "",
    sort: filters.sort,
  };
}

function isValidStage(value: string): value is CasefileWorkflowStage {
  return CASEFILE_WORKFLOW_STAGES.includes(value as CasefileWorkflowStage);
}

function isValidSource(value: string): value is RecordingSource {
  return value === "upload" || value === "record";
}

function isValidSort(value: string): value is WorkInboxFilters["sort"] {
  return value === "default" || value === "updated_desc" || value === "updated_asc";
}

function buildHref(role: UserRole, filters: WorkInboxFilters, state: FilterFormState) {
  const params = new URLSearchParams();
  const query = state.query.trim();
  const assignmentUserId = state.assignmentUserId.trim();

  if (filters.tab !== DEFAULT_TAB[role]) {
    params.set("tab", filters.tab);
  }
  if (query) {
    params.set("query", query);
  }
  if (isValidStage(state.stage)) {
    params.set("stage", state.stage);
  }
  if (isValidSource(state.source)) {
    params.set("source", state.source);
  }
  if (role === "admin" && assignmentUserId) {
    params.set("assignmentUserId", assignmentUserId);
  }
  if (isValidSort(state.sort) && state.sort !== "default") {
    params.set("sort", state.sort);
  }

  const search = params.toString();
  return search ? `/workspace?${search}` : "/workspace";
}

export function WorkFilters({
  role,
  filters,
  resultCount,
}: {
  role: UserRole;
  filters: WorkInboxFilters;
  resultCount: number;
}) {
  const router = useRouter();
  const [formState, setFormState] = useState<FilterFormState>(() => toFormState(filters));

  useEffect(() => {
    setFormState(toFormState(filters));
  }, [filters]);

  const resultLabel = useMemo(
    () => `${resultCount} ${resultCount === 1 ? "result" : "results"}`,
    [resultCount],
  );

  function update(nextState: FilterFormState) {
    setFormState(nextState);
    router.replace(buildHref(role, filters, nextState), { scroll: false });
  }

  return (
    <section aria-labelledby="work-filters-title" className="work-filters-surface">
      <div className="work-filters-header">
        <h2 className="work-filters-title" id="work-filters-title">
          Filters
        </h2>
        <p aria-atomic="true" aria-live="polite" className="work-filters-results" role="status">
          {resultLabel}
        </p>
      </div>
      <form className="work-filters" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label className="field-label" htmlFor="work-search-recordings">
            Search recordings
          </label>
          <input
            id="work-search-recordings"
            onChange={(event) => update({ ...formState, query: event.target.value })}
            type="search"
            value={formState.query}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="work-stage-filter">
            Stage
          </label>
          <select
            id="work-stage-filter"
            onChange={(event) => update({ ...formState, stage: event.target.value })}
            value={formState.stage}
          >
            <option value="">All stages</option>
            {CASEFILE_WORKFLOW_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="work-source-filter">
            Source
          </label>
          <select
            id="work-source-filter"
            onChange={(event) => update({ ...formState, source: event.target.value })}
            value={formState.source}
          >
            <option value="">All sources</option>
            {SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {role === "admin" ? (
          <div className="field">
            <label className="field-label" htmlFor="work-assignment-filter">
              Assigned user ID
            </label>
            <input
              id="work-assignment-filter"
              onChange={(event) =>
                update({ ...formState, assignmentUserId: event.target.value })
              }
              value={formState.assignmentUserId}
            />
          </div>
        ) : null}
        <div className="field">
          <label className="field-label" htmlFor="work-sort-filter">
            Sort
          </label>
          <select
            id="work-sort-filter"
            onChange={(event) =>
              update({
                ...formState,
                sort: isValidSort(event.target.value) ? event.target.value : "default",
              })
            }
            value={formState.sort}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </form>
    </section>
  );
}
