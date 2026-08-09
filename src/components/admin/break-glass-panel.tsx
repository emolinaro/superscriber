"use client";

import { useEffect, useState, useTransition } from "react";
import type { BreakGlassPanelModel } from "@/server/administration/service";
import {
  beginBreakGlassKeyEnrollmentAction,
  completeBreakGlassKeyEnrollmentAction,
  designateBreakGlassAdminAction,
  rotateBreakGlassRecoveryCodesAction,
} from "@/server/actions/break-glass-actions";

/**
 * Emergency-access management surface for admins (plan section 8). Key
 * enrollment uses a hand-rolled navigator.credentials.create ceremony; the
 * recovery codes are displayed exactly once and never re-rendered.
 */

function base64urlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer as ArrayBuffer;
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function creationOptionsToNative(publicKey: Record<string, unknown>) {
  const user = publicKey.user as Record<string, unknown>;
  return {
    ...publicKey,
    challenge: base64urlToBuffer(String(publicKey.challenge)),
    user: { ...user, id: base64urlToBuffer(String(user.id)) },
    excludeCredentials: ((publicKey.excludeCredentials as Array<Record<string, unknown>>) ?? []).map(
      (entry) => ({ ...entry, id: base64urlToBuffer(String(entry.id)) }),
    ),
  } as PublicKeyCredentialCreationOptions;
}

function attestationToJSON(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      transports:
        typeof response.getTransports === "function" ? response.getTransports() : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

export function BreakGlassPanel({
  model,
  phoneSafetyMode,
}: {
  model: BreakGlassPanelModel;
  phoneSafetyMode: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [designeeId, setDesigneeId] = useState("");
  const [designateReason, setDesignateReason] = useState("");
  const [keyLabel, setKeyLabel] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (phoneSafetyMode) {
      setRecoveryCodes(null);
    }
  }, [phoneSafetyMode]);

  return (
    <section aria-labelledby="break-glass-heading" className="panel">
      <div className="panel-inner stack-tight">
        <h2 className="card-title" id="break-glass-heading">
          Emergency access (break-glass)
        </h2>

        {model.designation ? (
          <p className="body-copy" data-testid="break-glass-status">
            Designated custodian: <strong>{model.designation.displayName}</strong>. Security keys
            enrolled: {model.enrolledKeyCount}. Unused recovery codes: {model.recoveryCodeCount}.
          </p>
        ) : (
          <p className="body-copy" data-testid="break-glass-status">
            No break-glass administrator is designated. Authentik-primary mode cannot start until
            one exists with two enrolled security keys and issued recovery codes.
          </p>
        )}

        {error ? (
          <p className="banner" data-tone="danger" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="banner" data-tone="ok" role="status">
            {notice}
          </p>
        ) : null}

        {!phoneSafetyMode && !model.designation ? (
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor="bg-designee">
                Designate active admin
              </label>
              <select
                id="bg-designee"
                onChange={(event) => setDesigneeId(event.target.value)}
                value={designeeId}
              >
                <option value="">Choose...</option>
                {model.adminCandidates.map((admin) => (
                  <option key={admin.id} value={admin.id}>
                    {admin.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="bg-reason">
                Change reason
              </label>
              <input
                id="bg-reason"
                onChange={(event) => setDesignateReason(event.target.value)}
                type="text"
                value={designateReason}
              />
            </div>
            <button
              className="button button-primary"
              disabled={isPending || !designeeId || designateReason.trim().length < 4}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await designateBreakGlassAdminAction({
                    userId: designeeId,
                    changeReason: designateReason,
                  });
                  if (result.ok) {
                    setNotice("Break-glass administrator designated.");
                    window.location.reload();
                  } else {
                    setError(result.error);
                  }
                });
              }}
              type="button"
            >
              Designate custodian
            </button>
          </div>
        ) : null}

        {model.designation && !model.viewerIsCustodian ? (
          <p className="field-note" data-testid="break-glass-custody-note">
            Custody operations require the designated custodian's own session.
          </p>
        ) : null}

        {!phoneSafetyMode && model.designation && model.viewerIsCustodian ? (
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor="bg-key-label">
                Security key label
              </label>
              <input
                id="bg-key-label"
                onChange={(event) => setKeyLabel(event.target.value)}
                placeholder="Custodian A key"
                type="text"
                value={keyLabel}
              />
            </div>
            <button
              className="button button-quiet"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const begun = await beginBreakGlassKeyEnrollmentAction({ label: keyLabel });
                  if (!begun.ok) {
                    setError(begun.error);
                    return;
                  }
                  try {
                    const credential = (await navigator.credentials.create({
                      publicKey: creationOptionsToNative(begun.publicKey),
                    })) as PublicKeyCredential | null;
                    if (!credential) {
                      setError("No security key material was produced.");
                      return;
                    }
                    const completed = await completeBreakGlassKeyEnrollmentAction({
                      challengeId: begun.challengeId,
                      credential: attestationToJSON(credential),
                      label: keyLabel,
                    });
                    if (completed.ok) {
                      setNotice("Security key enrolled.");
                      window.location.reload();
                    } else {
                      setError(completed.error);
                    }
                  } catch (enrollError) {
                    console.error("security key enrollment failed", enrollError);
                    setError("Security key enrollment was cancelled or unsupported here.");
                  }
                });
              }}
              type="button"
            >
              Enroll security key
            </button>

            <button
              className="button button-quiet"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await rotateBreakGlassRecoveryCodesAction();
                  if (result.ok) {
                    setRecoveryCodes(result.codes);
                  } else {
                    setError(result.error);
                  }
                });
              }}
              type="button"
            >
              Issue new recovery codes
            </button>
          </div>
        ) : null}

        {!phoneSafetyMode && recoveryCodes ? (
          <div aria-live="polite" className="break-glass-codes" role="alert">
            <p className="field-note">
              Save these codes now under dual custody. They are shown once and never again.
            </p>
            <ol>
              {recoveryCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}
