"use client";

import { USER_ROLES, type UserRole } from "@/domain/models";
import { formatRoleLabel } from "@/lib/format";
import type { AccountRoleChangeFailure } from "@/lib/account-role-management";
import type { AdministrationAccountsViewModel } from "@/server/administration/service";

export type RoleEditorState = {
  selectedRole: UserRole;
  reason: string;
  phase: "persisted" | "dirty" | "pending" | "error";
  fieldError: string | null;
  operationError: AccountRoleChangeFailure | null;
};

export function emptyRoleEditorState(role: UserRole): RoleEditorState {
  return {
    selectedRole: role,
    reason: "",
    phase: "persisted",
    fieldError: null,
    operationError: null,
  };
}

export type AccountRoleEditorProps = {
  user: AdministrationAccountsViewModel["users"][number];
  presentationId: string;
  state: RoleEditorState;
  mutationsDisabled: boolean;
  onSelectedRoleChange(role: UserRole): void;
  onReasonChange(reason: string): void;
  onSubmit(): void;
  onCancel(): void;
};

function joinIds(ids: Array<string | null>) {
  const present = ids.filter((id): id is string => Boolean(id));
  return present.length > 0 ? present.join(" ") : undefined;
}

function knownGuidance(
  user: AccountRoleEditorProps["user"],
  selectedRole: UserRole,
) {
  const guidance: string[] = [];
  if (user.hasActiveOidcIdentity) {
    guidance.push(
      `Institutional sign-in is linked. Set exactly one Authentik role group for ${formatRoleLabel(selectedRole)} before this account signs in again.`,
    );
  }
  if (selectedRole !== "admin" && user.isBreakGlassAdministrator) {
    guidance.push(
      "This account is the designated break-glass administrator. Transfer the designation before changing its role.",
    );
  }
  if (selectedRole !== "admin" && user.isSoleActiveAdministrator) {
    guidance.push(
      "At least one active administrator must remain. Promote another active account to Administrator before changing this role.",
    );
  }
  for (const role of ["reviewer", "approver"] as const) {
    const count = user.activeAssignments[role];
    if (count > 0 && selectedRole !== role) {
      guidance.push(
        `${count} active ${formatRoleLabel(role)} ${count === 1 ? "assignment" : "assignments"} must be removed before this role can change.`,
      );
    }
  }
  return guidance;
}

export function AccountRoleEditor({
  user,
  presentationId,
  state,
  mutationsDisabled,
  onSelectedRoleChange,
  onReasonChange,
  onSubmit,
  onCancel,
}: AccountRoleEditorProps) {
  const selectId = `account-role-${presentationId}`;
  const reasonId = `account-role-reason-${presentationId}`;
  const reasonErrorId = `account-role-reason-error-${presentationId}`;
  const guidanceId = `account-role-guidance-${presentationId}`;
  const alertId = `account-role-alert-${presentationId}`;
  const dirty = state.phase !== "persisted";
  const pending = state.phase === "pending";
  const disabled = mutationsDisabled || pending;
  const guidance = dirty ? knownGuidance(user, state.selectedRole) : [];

  return (
    <form
      aria-busy={pending ? true : undefined}
      className="account-role-editor"
      noValidate
      onKeyDown={(event) => {
        if (event.key === "Escape" && dirty && !pending) {
          event.preventDefault();
          onCancel();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && dirty) {
          onSubmit();
        }
      }}
    >
      <label className="sr-only" htmlFor={selectId}>
        Role for {user.displayName}
      </label>
      <select
        aria-describedby={joinIds([
          guidance.length > 0 ? guidanceId : null,
          state.operationError ? alertId : null,
        ])}
        data-account-role-select
        data-account-user-id={user.id}
        disabled={disabled}
        id={selectId}
        name="newRole"
        onChange={(event) => onSelectedRoleChange(event.target.value as UserRole)}
        value={state.selectedRole}
      >
        {USER_ROLES.map((role) => (
          <option key={role} value={role}>
            {formatRoleLabel(role)}
          </option>
        ))}
      </select>

      {dirty ? (
        <div className="account-role-editor__details">
          {guidance.length > 0 ? (
            <ul className="account-role-editor__guidance" id={guidanceId}>
              {guidance.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}

          <div className="field account-role-editor__reason">
            <label className="field-label" htmlFor={reasonId}>
              Change reason
              <span className="sr-only"> for {user.displayName}</span>
            </label>
            <input
              aria-label={`Change reason for ${user.displayName}`}
              aria-describedby={joinIds([
                state.fieldError ? reasonErrorId : null,
                guidance.length > 0 ? guidanceId : null,
                state.operationError ? alertId : null,
              ])}
              aria-invalid={state.fieldError ? true : undefined}
              data-account-role-reason
              data-account-user-id={user.id}
              disabled={disabled}
              id={reasonId}
              name="reason"
              onChange={(event) => onReasonChange(event.target.value)}
              required
              type="text"
              value={state.reason}
            />
            {state.fieldError ? (
              <p className="field-error-message" id={reasonErrorId}>
                {state.fieldError}
              </p>
            ) : null}
          </div>

          {state.operationError ? (
            <div
              className="account-role-editor__alert banner"
              data-account-role-alert
              data-account-user-id={user.id}
              data-tone="danger"
              id={alertId}
              role="alert"
              tabIndex={-1}
            >
              <p>{state.operationError.message}</p>
              {state.operationError.assignmentBlockers ? (
                <>
                  <ul>
                    {state.operationError.assignmentBlockers.byRole.map((blocker) => {
                      const undisplayed = blocker.count - blocker.recordingTitles.length;
                      return (
                        <li key={blocker.role}>
                          <strong>
                            {blocker.count} {formatRoleLabel(blocker.role)} {blocker.count === 1 ? "assignment" : "assignments"}
                          </strong>
                          <ul>
                            {blocker.recordingTitles.map((title) => (
                              <li key={title}>{title}</li>
                            ))}
                          </ul>
                          {undisplayed > 0 ? (
                            <span>
                              and {undisplayed} {undisplayed === 1 ? "more" : "more"}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  <a href={state.operationError.assignmentBlockers.managementHref}>
                    Open active assignments
                  </a>
                </>
              ) : null}
              {state.operationError.correlationId ? (
                <p>Reference: {state.operationError.correlationId}</p>
              ) : null}
            </div>
          ) : null}

          <div className="button-row account-role-editor__controls">
            <button
              className="button button-primary"
              disabled={disabled}
              type="submit"
            >
              {pending ? "Saving role..." : "Save role"}
            </button>
            <button
              className="button button-secondary"
              disabled={disabled}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
