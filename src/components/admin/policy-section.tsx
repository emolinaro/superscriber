"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { POLICY_PROFILES, type PolicyProfileId } from "@/domain/models";
import { InlineNotice } from "@/components/ui/inline-notice";
import { updateWorkspacePolicyAction } from "@/server/actions/administration-actions";
import type { AdministrationPolicyViewModel } from "@/server/administration/service";

const PROFILE_LABELS: Record<PolicyProfileId, string> = {
  strict: "Strict",
  "reviewable-approved-export": "Reviewable approved export",
};

/**
 * Policy profile editing (demo-governance-bringback): the profile is the
 * workspace's one governed setting - previously surface-readable only.
 * Admin-authored edits persist through the server action and write a redacted
 * policy.updated security event (actor + from/to).
 */
export function PolicySection({
  model,
  phoneSafetyMode,
}: {
  model: AdministrationPolicyViewModel;
  phoneSafetyMode: boolean;
}) {
  const router = useRouter();
  const [profileId, setProfileId] = useState<PolicyProfileId>(model.profile.id);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = profileId !== model.profile.id;

  function save() {
    setNotice(null);
    setError(null);
    startTransition(async () => {
      const result = await updateWorkspacePolicyAction({ profileId });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNotice(result.notice ?? "Workspace policy profile updated.");
      router.refresh();
    });
  }

  return (
    <section className="panel panel-strong administration-section stack" aria-labelledby="policy-heading">
      <div className="panel-inner stack administration-section__body">
        <div className="stack-tight">
          <p className="eyebrow">Policy</p>
          <h2 className="section-title" id="policy-heading" tabIndex={-1}>
            Policy
          </h2>
          <p className="body-copy">{model.profile.description}</p>
        </div>

        <div className="administration-policy-meta">
          <strong>{model.profile.label}</strong>
          <span>{model.profile.id}</span>
        </div>

        {!phoneSafetyMode ? (
          <div className="field" data-testid="policy-editor">
            <label className="field-label" htmlFor="policy-profile">
              Workspace policy profile
            </label>
            <select
              id="policy-profile"
              onChange={(event) => setProfileId(event.currentTarget.value as PolicyProfileId)}
              value={profileId}
            >
              {POLICY_PROFILES.map((id) => (
                <option key={id} value={id}>
                  {PROFILE_LABELS[id]}
                </option>
              ))}
            </select>
            <span className="field-note">
              Applies to every casefile immediately; capability tables below describe the active profile.
            </span>
            <div className="button-row">
              <button
                className="button button-primary"
                disabled={!dirty || pending}
                onClick={save}
                type="button"
              >
                {pending ? "Applying..." : "Apply policy"}
              </button>
            </div>
            {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}
            {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          </div>
        ) : null}

        <div className="administration-table-wrap">
          <table className="administration-table administration-policy-table">
            <thead>
              <tr>
                <th scope="col">Capability</th>
                <th scope="col">Uploader</th>
                <th scope="col">Reviewer</th>
                <th scope="col">Approver</th>
                <th scope="col">Admin</th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.label}</th>
                  <td>{row.uploader}</td>
                  <td>{row.reviewer}</td>
                  <td>{row.approver}</td>
                  <td>{row.admin}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="administration-card-list">
          {model.rows.map((row) => (
            <li className="administration-card-list__item" key={row.id}>
              <article className="administration-card stack-tight">
                <h3 className="card-title">{row.label}</h3>
                <dl className="administration-fact-list">
                  <div>
                    <dt>Uploader</dt>
                    <dd>{row.uploader}</dd>
                  </div>
                  <div>
                    <dt>Reviewer</dt>
                    <dd>{row.reviewer}</dd>
                  </div>
                  <div>
                    <dt>Approver</dt>
                    <dd>{row.approver}</dd>
                  </div>
                  <div>
                    <dt>Admin</dt>
                    <dd>{row.admin}</dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
