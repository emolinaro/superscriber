"use client";

import { useEffect, useMemo, useState } from "react";
import type { CasefileViewModel } from "@/server/casefile/read-model";

const GOVERNANCE_TABS = ["Policy", "Provenance", "Assignments", "Revisions", "Decisions", "Audit"] as const;

type GovernanceTab = (typeof GOVERNANCE_TABS)[number];

type ViewportMode = "phone" | "tablet" | "desktop";

function readViewportMode(): ViewportMode {
  if (typeof window === "undefined") {
    return "phone";
  }

  if (window.innerWidth < 768) {
    return "phone";
  }

  if (window.innerWidth < 1100) {
    return "tablet";
  }

  return "desktop";
}

function tabPanel(casefile: CasefileViewModel, tab: GovernanceTab) {
  switch (tab) {
    case "Policy":
      return (
        <dl className="governance-panel__list">
          <div><dt>Media</dt><dd>{casefile.policy.mediaAccessLabel}</dd></div>
          <div><dt>Draft edit</dt><dd>{casefile.policy.draftEditLabel}</dd></div>
          <div><dt>Approval</dt><dd>{casefile.policy.approvalLabel}</dd></div>
          <div><dt>Reopen</dt><dd>{casefile.policy.reopenLabel}</dd></div>
          <div><dt>Export</dt><dd>{casefile.policy.transcriptExportLabel}</dd></div>
        </dl>
      );
    case "Provenance":
      return (
        <dl className="governance-panel__list">
          <div><dt>Source</dt><dd>{casefile.sourceLabel}</dd></div>
          <div><dt>Language</dt><dd>{casefile.provenance.languageHint}</dd></div>
          <div><dt>File</dt><dd>{casefile.provenance.originalFileName ?? "-"}</dd></div>
          <div><dt>Verification</dt><dd>{casefile.provenance.verificationSummary ?? "-"}</dd></div>
        </dl>
      );
    case "Assignments":
      return (
        <ul className="governance-panel__items">
          {casefile.assignments.map((assignment) => (
            <li key={assignment.id}>
              <strong>{assignment.userDisplay}</strong>
              <span>{assignment.assignmentRole}</span>
              <span>{assignment.status}</span>
            </li>
          ))}
        </ul>
      );
    case "Revisions":
      return (
        <ul className="governance-panel__items">
          {casefile.revisions.map((revision) => (
            <li key={revision.id}>
              <strong>v{revision.version}</strong>
              <span>{revision.stateLabel}</span>
              <span>{revision.summary}</span>
            </li>
          ))}
        </ul>
      );
    case "Decisions":
      return (
        <ul className="governance-panel__items">
          {casefile.decisions.map((decision) => (
            <li key={decision.id}>
              <strong>{decision.label}</strong>
              <span>{decision.actorDisplay}</span>
            </li>
          ))}
        </ul>
      );
    case "Audit":
      return (
        <ul className="governance-panel__items">
          {casefile.audit.map((event) => (
            <li key={event.id}>
              <strong>{event.type}</strong>
              <span>{event.detail}</span>
            </li>
          ))}
        </ul>
      );
  }
}

function DesktopDrawer({
  casefile,
  open,
  setOpen,
  activeTab,
  setActiveTab,
}: {
  casefile: CasefileViewModel;
  open: boolean;
  setOpen: (value: boolean) => void;
  activeTab: GovernanceTab;
  setActiveTab: (value: GovernanceTab) => void;
}) {
  return (
    <aside className="governance-drawer" data-open={open || undefined}>
      <button
        aria-expanded={open}
        className="button button-secondary governance-drawer__toggle"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {open ? "Close governance" : "Open governance"}
      </button>
      {open ? (
        <div className="governance-drawer__surface">
          <div aria-label="Governance tabs" className="governance-tabs" role="tablist">
            {GOVERNANCE_TABS.map((tab) => (
              <button
                aria-selected={activeTab === tab}
                className="governance-tabs__tab"
                key={tab}
                onClick={() => setActiveTab(tab)}
                role="tab"
                type="button"
              >
                {tab}
              </button>
            ))}
          </div>
          <div className="governance-panel" role="tabpanel">
            {tabPanel(casefile, activeTab)}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function TabletDrawer({
  casefile,
  open,
  setOpen,
  activeTab,
  setActiveTab,
}: {
  casefile: CasefileViewModel;
  open: boolean;
  setOpen: (value: boolean) => void;
  activeTab: GovernanceTab;
  setActiveTab: (value: GovernanceTab) => void;
}) {
  return (
    <div className="governance-tablet-drawer">
      <button
        aria-expanded={open}
        className="button button-secondary governance-drawer__toggle"
        onClick={() => setOpen(true)}
        type="button"
      >
        Open governance
      </button>
      {open ? (
        <div className="governance-tablet-drawer__backdrop" role="presentation">
          <aside aria-label="Governance" aria-modal="true" className="governance-tablet-drawer__surface" role="dialog">
            <div aria-label="Governance tabs" className="governance-tabs" role="tablist">
              {GOVERNANCE_TABS.map((tab) => (
                <button
                  aria-selected={activeTab === tab}
                  className="governance-tabs__tab"
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  role="tab"
                  type="button"
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="governance-panel" role="tabpanel">
              {tabPanel(casefile, activeTab)}
            </div>
            <button className="button button-primary" onClick={() => setOpen(false)} type="button">
              Close governance
            </button>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function PhoneAccordions({ casefile }: { casefile: CasefileViewModel }) {
  return (
    <section className="governance-accordions" aria-label="Governance">
      {GOVERNANCE_TABS.map((tab) => (
        <details className="governance-accordion" key={tab}>
          <summary>{tab}</summary>
          <div className="governance-panel">{tabPanel(casefile, tab)}</div>
        </details>
      ))}
    </section>
  );
}

export function GovernanceDrawer({ casefile }: { casefile: CasefileViewModel }) {
  const [viewportMode, setViewportMode] = useState<ViewportMode>("phone");
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<GovernanceTab>("Policy");

  useEffect(() => {
    const update = () => setViewportMode(readViewportMode());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (viewportMode !== "desktop") {
      setOpen(false);
    }
  }, [viewportMode]);

  const drawer = useMemo(() => {
    if (viewportMode === "phone") {
      return <PhoneAccordions casefile={casefile} />;
    }

    if (viewportMode === "tablet") {
      return (
        <TabletDrawer
          activeTab={activeTab}
          casefile={casefile}
          open={open}
          setActiveTab={setActiveTab}
          setOpen={setOpen}
        />
      );
    }

    return (
      <DesktopDrawer
        activeTab={activeTab}
        casefile={casefile}
        open={open}
        setActiveTab={setActiveTab}
        setOpen={setOpen}
      />
    );
  }, [activeTab, casefile, open, viewportMode]);

  return drawer;
}
