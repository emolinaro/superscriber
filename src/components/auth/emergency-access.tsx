"use client";

import { useState, useTransition } from "react";
import { signIn } from "next-auth/react";
import {
  beginEmergencyAccessAction,
  beginEmergencyRecoveryAction,
  completeEmergencyKeyAssertionAction,
} from "@/server/actions/break-glass-actions";

/**
 * Emergency local administrator access. Hand-rolled browser ceremony with
 * navigator.credentials per the dependency decision (no browser library).
 * All denials are generic; the server decides what happens next.
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

export function publicKeyRequestToNative(publicKey: Record<string, unknown>) {
  return {
    ...publicKey,
    challenge: base64urlToBuffer(String(publicKey.challenge)),
    allowCredentials: ((publicKey.allowCredentials as Array<Record<string, unknown>>) ?? []).map(
      (entry) => ({
        ...entry,
        id: base64urlToBuffer(String(entry.id)),
      }),
    ),
  } as PublicKeyCredentialRequestOptions;
}

export function credentialToJSON(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      authenticatorData: bufferToBase64url(response.authenticatorData),
      signature: bufferToBase64url(response.signature),
      userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

type Stage =
  | { step: "credentials" }
  | { step: "key"; challengeId: string; publicKey: Record<string, unknown> }
  | { step: "recovery" };

const DENIAL = "The emergency access request was not accepted.";

export function EmergencyAccess() {
  const [stage, setStage] = useState<Stage>({ step: "credentials" });
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function finishWithCeremony(ceremonyToken: string) {
    const result = await signIn("credentials", {
      breakGlassCeremony: ceremonyToken,
      redirect: false,
      callbackUrl: "/workspace",
    });
    if (result?.ok) {
      window.location.assign("/workspace");
      return;
    }
    setError(DENIAL);
    setStage({ step: "credentials" });
  }

  return (
    <details className="break-glass-disclosure" data-testid="break-glass-disclosure">
      <summary>Emergency local administrator</summary>
      <div className="stack-tight">
        <p className="field-note">
          Emergency access is limited to the designated custodian account on approved management
          networks, with a hardware security key or a recovery code. Every attempt is recorded.
        </p>

        {error ? (
          <p className="banner" data-tone="danger" role="alert">
            {error}
          </p>
        ) : null}

        {stage.step === "credentials" ? (
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor="emg-password">
                Custodian password
              </label>
              <input
                autoComplete="off"
                id="emg-password"
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="emg-reason">
                Incident reason
              </label>
              <textarea
                id="emg-reason"
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                value={reason}
              />
              <p className="field-note">10-500 characters; recorded with the activation.</p>
            </div>
            <button
              className="button button-primary"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await beginEmergencyAccessAction({ password, reason });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  if ("ceremonyToken" in result) {
                    await finishWithCeremony(result.ceremonyToken);
                    return;
                  }
                  if ("needsRecovery" in result) {
                    setStage({ step: "recovery" });
                    return;
                  }
                  setStage({ step: "key", challengeId: result.challengeId, publicKey: result.publicKey });
                });
              }}
              type="button"
            >
              Continue to security key
            </button>
          </div>
        ) : null}

        {stage.step === "key" ? (
          <div className="stack-tight">
            <p className="field-note">Touch your registered hardware security key now.</p>
            <button
              className="button button-primary"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  try {
                    const credential = (await navigator.credentials.get({
                      publicKey: publicKeyRequestToNative(stage.publicKey),
                    })) as PublicKeyCredential | null;
                    if (!credential) {
                      setError(DENIAL);
                      return;
                    }
                    const completed = await completeEmergencyKeyAssertionAction({
                      challengeId: stage.challengeId,
                      credential: credentialToJSON(credential),
                      reason,
                    });
                    if (!completed.ok) {
                      setError(completed.error);
                      setStage({ step: "credentials" });
                      return;
                    }
                    await finishWithCeremony(completed.ceremonyToken);
                  } catch (keyError) {
                    console.error("emergency key step failed", keyError);
                    setError(DENIAL);
                  }
                });
              }}
              type="button"
            >
              Use security key
            </button>
            <button className="button button-quiet" onClick={() => setStage({ step: "recovery" })} type="button">
              Use a recovery code instead
            </button>
          </div>
        ) : null}

        {stage.step === "recovery" ? (
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor="emg-code">
                Recovery code
              </label>
              <input
                autoComplete="off"
                id="emg-code"
                onChange={(event) => setRecoveryCode(event.target.value)}
                type="text"
                value={recoveryCode}
              />
            </div>
            <button
              className="button button-primary"
              disabled={isPending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await beginEmergencyRecoveryAction({
                    password,
                    recoveryCode,
                    reason,
                  });
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  if ("ceremonyToken" in result) {
                    await finishWithCeremony(result.ceremonyToken);
                  }
                });
              }}
              type="button"
            >
              Start emergency session
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
