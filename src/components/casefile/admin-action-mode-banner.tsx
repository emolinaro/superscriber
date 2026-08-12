"use client";

import { useEffect, useState } from "react";
import { formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import { InlineNotice } from "@/components/ui/inline-notice";
import {
  AdminActionModeEntry,
  type AdminActionModeEntryOption,
  type AdminActionModeResult,
  type AdminActionModeRole,
} from "./admin-action-mode-entry";

export type AdminActionModeSessionView = {
  id: string;
  effectiveRole: AdminActionModeRole;
  adminDisplayName: string;
  baseRole: "admin";
  purpose: string;
  expiresAt: string;
};

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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session) {
      setPending(false);
      setError(null);
    }
  }, [session]);

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
    <AdminActionModeEntry
      entryOptions={entryOptions}
      onEnter={onEnter}
      recordingTitle={recordingTitle}
      sessionId={null}
    />
  );
}
