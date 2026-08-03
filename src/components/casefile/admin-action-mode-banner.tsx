"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Modal } from "@/components/ui/modal";

export type AdminActionModeRole = "reviewer" | "approver";

export type AdminActionModeEntryOption = {
  effectiveRole: AdminActionModeRole;
};

export type AdminActionModeSessionView = {
  id: string;
  effectiveRole: AdminActionModeRole;
  adminDisplayName: string;
  baseRole: "admin";
  purpose: string;
  expiresAt: string;
};

export type AdminActionModeResult =
  | { ok: true }
  | {
      ok: false;
      error?: string | null;
    };

function isValidPurpose(value: string) {
  const trimmed = value.trim();
  return trimmed.length >= 10 && trimmed.length <= 500;
}

export function AdminActionModeBanner({
  entryOptions,
  onEnter,
  onExit,
  phoneSafetyMode,
  recordingTitle,
  session,
}: {
  entryOptions: AdminActionModeEntryOption[];
  onEnter: (input: {
    effectiveRole: AdminActionModeRole;
    purpose: string;
  }) => Promise<AdminActionModeResult> | AdminActionModeResult;
  onExit: () => Promise<AdminActionModeResult> | AdminActionModeResult;
  phoneSafetyMode: boolean;
  recordingTitle: string;
  session: AdminActionModeSessionView | null;
}) {
  const [open, setOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<AdminActionModeRole | null>(null);
  const [purpose, setPurpose] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = useMemo(() => isValidPurpose(purpose), [purpose]);

  useEffect(() => {
    if (session) {
      setOpen(false);
      setPending(false);
      setError(null);
      setPurpose("");
      setSelectedRole(null);
    }
  }, [session]);

  async function handleEnter() {
    if (!selectedRole || !valid || pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const result = await onEnter({
        effectiveRole: selectedRole,
        purpose: purpose.trim(),
      });
      if (!result.ok) {
        setError(result.error ?? null);
      }
    } finally {
      setPending(false);
    }
  }

  async function handleExit() {
    if (pending) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      const result = await onExit();
      if (!result.ok) {
        setError(result.error ?? null);
      }
    } finally {
      setPending(false);
    }
  }

  if (session) {
    return (
      <aside aria-label="Admin action mode" className="action-mode-banner">
        <strong>Admin action mode: {formatRoleLabel(session.effectiveRole)}</strong>
        <span>{session.adminDisplayName} (Admin)</span>
        <span>Base role: {formatRoleLabel(session.baseRole)}</span>
        <span>Purpose: {session.purpose}</span>
        <span>Expires {formatDateTimeUtc(session.expiresAt)}</span>
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        <button className="button button-secondary" onClick={() => void handleExit()} type="button">
          {pending ? "Working..." : "Exit action mode"}
        </button>
      </aside>
    );
  }

  if (phoneSafetyMode || entryOptions.length === 0) {
    return null;
  }

  return (
    <>
      <div className="button-row action-mode-entry-row">
        {entryOptions.map((option) => {
          const label = `Enter ${option.effectiveRole} action mode`;
          return (
            <button
              className="button button-secondary"
              key={option.effectiveRole}
              onClick={() => {
                setSelectedRole(option.effectiveRole);
                setOpen(true);
                setError(null);
              }}
              type="button"
            >
              {label}
            </button>
          );
        })}
      </div>

      <Modal onClose={() => setOpen(false)} open={open} title="Enter admin action mode">
        <div className="button-row modal-actions-row">
          <button className="button button-secondary" onClick={() => setOpen(false)} type="button">
            Close
          </button>
        </div>

        <div className="casefile-decision-dialog__facts">
          <p>Recording {recordingTitle}</p>
          <p>Effective role {selectedRole ? formatRoleLabel(selectedRole) : "-"}</p>
          <p>Base role Admin</p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="admin-action-mode-purpose">
            Purpose
          </label>
          <textarea
            id="admin-action-mode-purpose"
            maxLength={500}
            minLength={10}
            onChange={(event) => setPurpose(event.target.value)}
            value={purpose}
          />
          <div className="field-note-row">
            <span className="field-note">10-500 characters required.</span>
            <span className="field-note">{purpose.length}/500</span>
          </div>
        </div>

        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

        <div className="button-row">
          <button className="button button-secondary" onClick={() => setOpen(false)} type="button">
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={!valid || pending || !selectedRole}
            onClick={() => {
              void handleEnter();
            }}
            type="button"
          >
            {pending
              ? "Working..."
              : `Enter ${selectedRole ?? "reviewer"} action mode`}
          </button>
        </div>
      </Modal>
    </>
  );
}
