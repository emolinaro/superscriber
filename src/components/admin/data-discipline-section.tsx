"use client";

import { useRef, useState, useTransition } from "react";

import { resetLedgerAction } from "@/server/actions/administration-actions";
import { Modal } from "@/components/ui/modal";
import { InlineNotice } from "@/components/ui/inline-notice";
import type { AdministrationDisciplineViewModel } from "@/server/administration/service";

// demo-ledger-reset: the administration "Data discipline" pane. One-way wipe
// of the governed ledger tables with a hard double gate (admin base role +
// typed phrase RESET REQUIRED, both rechecked server-side), and exactly one
// surviving security-event record describing what was cleared.
export function DataDisciplineSection({
  counts,
  phoneSafetyMode,
}: {
  counts: AdministrationDisciplineViewModel["counts"];
  phoneSafetyMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const matches = phrase.trim() === "RESET REQUIRED";

  return (
    <section aria-labelledby="discipline-heading" className="discipline-section panel panel-strong panel-inner">
      <h2 id="discipline-heading">Data discipline</h2>
      <p className="field-note">
        Records reset versus retention for the demo lane. The ledger below counts rows belonging
        to the governed ledgers; the reset clears them without touching recordings, revisions,
        users, sessions, or media.
      </p>

      <dl className="discipline-section__counts">
        <div>
          <dt>Audit events</dt>
          <dd>{counts.auditEvents}</dd>
        </div>
        <div>
          <dt>Decision rows</dt>
          <dd>{counts.decisionRows}</dd>
        </div>
        <div>
          <dt>Governance action sessions</dt>
          <dd>{counts.govActionSessions}</dd>
        </div>
        <div>
          <dt>Ended assignments</dt>
          <dd>{counts.endedAssignments}</dd>
        </div>
        <div>
          <dt>Security events</dt>
          <dd>{counts.securityEvents}</dd>
        </div>
      </dl>

      {phoneSafetyMode ? null : (
        <div className="button-row">
          <button
            className="button button-danger"
            onClick={() => {
              setPhrase("");
              setError(null);
              setOpen(true);
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
            type="button"
          >
            Reset the governed ledger...
          </button>
        </div>
      )}

      <Modal
        onClose={() => {
          if (!pending) {
            setOpen(false);
          }
        }}
        open={open}
        title="Reset the governed ledger?"
      >
        <div className="stack-tight">
          <p>
            This clears audit events, decision rows, governance action sessions, ended
            assignments, and security events across the workspace. Recordings, revisions,
            users, active assignments, and live sessions are untouched. Exactly one reset
            record survives in the audit ledger so the wipe is itself auditable.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="discipline-confirm">
              Type RESET REQUIRED to confirm
            </label>
            <input
              autoComplete="off"
              id="discipline-confirm"
              onChange={(event) => setPhrase(event.currentTarget.value)}
              placeholder="RESET REQUIRED"
              ref={inputRef}
              type="text"
              value={phrase}
            />
          </div>

          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

          <div className="button-row modal-actions-row">
            <button
              className="button button-secondary"
              disabled={pending}
              onClick={() => setOpen(false)}
              type="button"
            >
              Keep the ledger
            </button>
            <button
              className="button button-danger"
              disabled={!matches || pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await resetLedgerAction({ expectedPhrase: phrase.trim() });
                  if (!result.ok) {
                    setError(result.message ?? "Reset failed; nothing was cleared.");
                    return;
                  }
                  // Hard navigation OUTSIDE the transition: router.refresh()
                  // inside this async scope races the server re-render and can
                  // leave the count readout painted from the pre-reset model
                  // (same failure class the recording danger zone names). A
                  // hard reload repaints the counts from the server fresh.
                  window.location.assign(
                    `/administration?section=discipline&notice=${encodeURIComponent(result.notice ?? "Ledger reset complete.")}`,
                  );
                });
              }}
              type="button"
            >
              {pending ? "Resetting..." : "Reset the ledger"}
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
