"use client";

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import type { CasefileViewModel } from "@/server/casefile/read-model";
import { Modal } from "@/components/ui/modal";

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

function governanceTabSlug(tab: GovernanceTab) {
  return tab.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function GovernanceTabs({
  activeTab,
  casefile,
  setActiveTab,
}: {
  activeTab: GovernanceTab;
  casefile: CasefileViewModel;
  setActiveTab: (value: GovernanceTab) => void;
}) {
  const tabsId = useId();

  function tabId(tab: GovernanceTab) {
    return `${tabsId}-tab-${governanceTabSlug(tab)}`;
  }

  function panelId(tab: GovernanceTab) {
    return `${tabsId}-panel-${governanceTabSlug(tab)}`;
  }

  function activateTab(tab: GovernanceTab) {
    setActiveTab(tab);
    document.getElementById(tabId(tab))?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;

    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % GOVERNANCE_TABS.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + GOVERNANCE_TABS.length) % GOVERNANCE_TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = GOVERNANCE_TABS.length - 1;
        break;
      default:
        break;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    activateTab(GOVERNANCE_TABS[nextIndex]);
  }

  return (
    <>
      <div aria-label="Governance tabs" className="governance-tabs" role="tablist">
        {GOVERNANCE_TABS.map((tab, index) => (
          <button
            aria-controls={panelId(tab)}
            aria-selected={activeTab === tab}
            className="governance-tabs__tab"
            id={tabId(tab)}
            key={tab}
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            role="tab"
            tabIndex={activeTab === tab ? 0 : -1}
            type="button"
          >
            {tab}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={tabId(activeTab)}
        className="governance-panel"
        id={panelId(activeTab)}
        role="tabpanel"
      >
        {tabPanel(casefile, activeTab)}
      </div>
    </>
  );
}

function DesktopDrawer({
  activeTab,
  casefile,
  open,
  setActiveTab,
  setOpen,
}: {
  activeTab: GovernanceTab;
  casefile: CasefileViewModel;
  open: boolean;
  setActiveTab: (value: GovernanceTab) => void;
  setOpen: (value: boolean) => void;
}) {
  // demo-gov-placement: the trigger lives in the casefile header
  // ("Governance >"); the drawer renders only while open, so a closed state
  // leaves no rail column on the page.
  if (!open) {
    return null;
  }

  return (
    <aside aria-label="Governance" className="governance-drawer" data-open>
      <div className="governance-drawer__surface">
        <GovernanceTabs activeTab={activeTab} casefile={casefile} setActiveTab={setActiveTab} />
      </div>
    </aside>
  );
}

function TabletDrawer({
  activeTab,
  casefile,
  open,
  setActiveTab,
  setOpen,
}: {
  activeTab: GovernanceTab;
  casefile: CasefileViewModel;
  open: boolean;
  setActiveTab: (value: GovernanceTab) => void;
  setOpen: (value: boolean) => void;
}) {
  // demo-gov-placement: the tablet modal also opens from the header link;
  // its own secondary-side trigger row is gone.
  return (
    <div className="governance-tablet-drawer">
      <Modal
        backdropClassName="governance-tablet-drawer__backdrop"
        description="Inspect policy, provenance, assignments, revisions, decisions, and audit facts."
        onClose={() => setOpen(false)}
        open={open}
        surfaceClassName="governance-tablet-drawer__surface"
        title="Governance"
      >
        <GovernanceTabs activeTab={activeTab} casefile={casefile} setActiveTab={setActiveTab} />
        <button className="button button-primary" onClick={() => setOpen(false)} type="button">
          Close governance
        </button>
      </Modal>
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

export function GovernanceDrawer({
  casefile,
  open: controlledOpen,
  onOpenChange,
  onToggle,
}: {
  casefile: CasefileViewModel;
  /** demo-gov-placement: the header hosts the trigger; the workspace owns state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onToggle?: () => void;
}) {
  const [viewportMode, setViewportMode] = useState<ViewportMode>("phone");
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => {
    if (controlledOpen === undefined) {
      setInternalOpen(value);
    } else if (value !== controlledOpen) {
      onToggle?.();
    }
  };
  const [activeTab, setActiveTab] = useState<GovernanceTab>("Policy");

  useEffect(() => {
    const update = () => setViewportMode(readViewportMode());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (viewportMode === "phone" && open) {
      onToggle?.();
      if (controlledOpen === undefined) {
        setInternalOpen(false);
      }
    }
  }, [viewportMode]);

  useEffect(() => {
    onOpenChange?.(viewportMode === "desktop" && open);
  }, [onOpenChange, open, viewportMode]);

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
