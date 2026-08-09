"use client";

import type { AdministrationSection, AdministrationViewModel } from "@/server/administration/service";
import { usePhoneSafetyMode } from "@/components/ui/phone-safety";
import { AccountsSection } from "./accounts-section";
import { BreakGlassPanel } from "./break-glass-panel";
import { AssignmentsSection } from "./assignments-section";
import { PolicySection } from "./policy-section";

function sectionHref(section: AdministrationSection) {
  return `/administration?section=${section}`;
}

export function AdministrationShell({
  section,
  model,
}: {
  section: AdministrationSection;
  model: AdministrationViewModel;
}) {
  const phoneSafetyMode = usePhoneSafetyMode();

  return (
    <div className="shell shell-wide stack administration-shell">
      <section className="surface-intro surface-intro--administration">
        <div className="surface-intro__copy stack-tight">
          <p className="surface-intro__eyebrow">Administration</p>
          <h1 className="surface-intro__title">Institutional controls</h1>
          <p className="surface-intro__description">
            Manage governed accounts, assignment history, and policy facts from dedicated control surfaces.
          </p>
        </div>
      </section>

      <nav aria-label="Administration sections" className="administration-nav panel panel-strong">
        <div className="panel-inner administration-nav__inner">
          <a
            aria-current={section === "accounts" ? "page" : undefined}
            className="administration-nav__link interactive-target"
            href={sectionHref("accounts")}
          >
            Accounts
          </a>
          <a
            aria-current={section === "assignments" ? "page" : undefined}
            className="administration-nav__link interactive-target"
            href={sectionHref("assignments")}
          >
            Assignments
          </a>
          <a
            aria-current={section === "policy" ? "page" : undefined}
            className="administration-nav__link interactive-target"
            href={sectionHref("policy")}
          >
            Policy
          </a>
        </div>
      </nav>

      {phoneSafetyMode ? (
        <p className="administration-phone-notice panel panel-strong panel-inner" role="status">
          Administration changes require a wider screen. Inspect current accounts, assignments, and policy facts here.
        </p>
      ) : null}

      {model.section === "accounts" ? (
        <>
          {model.breakGlass ? (
            <BreakGlassPanel
              model={model.breakGlass}
              phoneSafetyMode={phoneSafetyMode}
            />
          ) : null}
          <AccountsSection model={model} phoneSafetyMode={phoneSafetyMode} />
        </>
      ) : null}
      {model.section === "assignments" ? (
        <AssignmentsSection model={model} phoneSafetyMode={phoneSafetyMode} />
      ) : null}
      {model.section === "policy" ? (
        <PolicySection model={model} phoneSafetyMode={phoneSafetyMode} />
      ) : null}
    </div>
  );
}
