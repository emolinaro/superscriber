"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { USER_ROLES, type UserRole } from "@/domain/models";
import { ErrorSummary } from "@/components/ui/error-summary";
import { Modal } from "@/components/ui/modal";
import type { CommandResult } from "@/lib/command-result";
import {
  ACCOUNT_ROLE_CHANGE_COPY,
  changeAccountRoleInputSchema,
  type AccountRoleChangeFailure,
  type ChangeAccountRoleInput,
} from "@/lib/account-role-management";
import { formatDateTimeIso, formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import type { AccountDirectoryEntry } from "@/server/access/service";
import type { AdministrationAccountsViewModel } from "@/server/administration/service";
import {
  changeAccountRoleAction as defaultChangeAccountRoleAction,
  createUserAction as defaultCreateUserAction,
  type AdministrationMutationResult,
  type ChangeAccountRoleActionResult,
  type CreateUserInput,
} from "@/server/actions/administration-actions";
import { localUserSchema } from "@/server/auth/validation";
import {
  AccountRoleEditor,
  emptyRoleEditorState,
  type RoleEditorState,
} from "./account-role-editor";

const FIELD_CONFIG = {
  displayName: { id: "account-display-name", label: "Name" },
  email: { id: "account-email", label: "Email" },
  password: { id: "account-password", label: "Password" },
  role: { id: "account-role", label: "Role" },
} as const;

type FieldName = keyof typeof FIELD_CONFIG;
type AccountValues = CreateUserInput;
type AccountRow = AdministrationAccountsViewModel["users"][number];

function emptyValues(): AccountValues {
  return {
    displayName: "",
    email: "",
    password: "",
    role: "reviewer",
  };
}

function fieldErrorsFromSchema(values: AccountValues) {
  const parsed = localUserSchema.safeParse(values);
  if (parsed.success) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(parsed.error.flatten().fieldErrors)
      .filter(([, value]) => typeof value?.[0] === "string")
      .map(([key, value]) => [key, value![0] as string]),
  ) as Partial<Record<FieldName, string>>;
}

function toAccountRow(user: AccountDirectoryEntry): AccountRow {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    roleLabel: formatRoleLabel(user.role),
    activeAssignmentCount: user.activeAssignmentCount,
    activeAssignments: { reviewer: 0, approver: 0 },
    hasActiveOidcIdentity: false,
    isBreakGlassAdministrator: false,
    isSoleActiveAdministrator: false,
    createdAt: user.createdAt,
    createdAtLabel: formatDateTimeUtc(user.createdAt),
    createdAtIso: formatDateTimeIso(user.createdAt),
  };
}

function prependAccountRow(user: AccountRow, rows: AccountRow[]) {
  return [user, ...rows.filter((row) => row.id !== user.id)];
}

function mergeAccountRows(modelUsers: AccountRow[], addedUsers: AccountRow[]) {
  const addedUserIds = new Set(addedUsers.map((user) => user.id));
  return [...addedUsers, ...modelUsers.filter((user) => !addedUserIds.has(user.id))];
}

const defaultNavigateToSignIn = (href: string) => window.location.assign(href);

type RoleFocusTarget = "select" | "reason" | "alert";

export function AccountsSection({
  model,
  phoneSafetyMode,
  createUserAction = defaultCreateUserAction,
  changeAccountRoleAction = defaultChangeAccountRoleAction,
  navigateToSignIn = defaultNavigateToSignIn,
}: {
  model: AdministrationAccountsViewModel;
  phoneSafetyMode: boolean;
  createUserAction?: (
    input: CreateUserInput,
  ) => Promise<CommandResult<AdministrationMutationResult>>;
  changeAccountRoleAction?: (
    input: ChangeAccountRoleInput,
  ) => Promise<ChangeAccountRoleActionResult>;
  navigateToSignIn?: (href: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [values, setValues] = useState<AccountValues>(emptyValues());
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusUserId, setFocusUserId] = useState<string | null>(null);
  const [addedUsers, setAddedUsers] = useState<AccountRow[]>([]);
  const [roleEditorStates, setRoleEditorStates] = useState<
    Record<string, RoleEditorState>
  >({});
  const [roleOverrides, setRoleOverrides] = useState<
    Partial<Record<string, UserRole>>
  >({});
  const [pendingRoleUserId, setPendingRoleUserId] = useState<string | null>(null);
  const [roleFocusRequest, setRoleFocusRequest] = useState<{
    userId: string;
    target: RoleFocusTarget;
  } | null>(null);
  const queryRef = useRef(model.query);

  const summaryErrors = useMemo(
    () =>
      (Object.entries(fieldErrors) as Array<[FieldName, string | undefined]>)
        .filter(([, message]) => typeof message === "string" && Boolean(message))
        .map(([field, message]) => ({
          fieldId: FIELD_CONFIG[field].id,
          label: FIELD_CONFIG[field].label,
          message: message!,
        })),
    [fieldErrors],
  );

  useEffect(() => {
    if (queryRef.current !== model.query) {
      queryRef.current = model.query;
      setAddedUsers([]);
      return;
    }

    setAddedUsers((current) => current.filter((user) => !model.users.some((modelUser) => modelUser.id === user.id)));
  }, [model.query, model.users]);

  const users = useMemo(
    () =>
      mergeAccountRows(model.users, addedUsers).map((user) => {
        const role = roleOverrides[user.id];
        return role
          ? { ...user, role, roleLabel: formatRoleLabel(role) }
          : user;
      }),
    [addedUsers, model.users, roleOverrides],
  );

  useEffect(() => {
    setRoleOverrides((current) => {
      const next = { ...current };
      let changed = false;
      for (const user of model.users) {
        if (next[user.id] === user.role) {
          delete next[user.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [model.users]);

  useEffect(() => {
    if (!phoneSafetyMode) {
      return;
    }
    setRoleEditorStates((current) => {
      if (pendingRoleUserId && current[pendingRoleUserId]) {
        return { [pendingRoleUserId]: current[pendingRoleUserId] };
      }
      return {};
    });
  }, [pendingRoleUserId, phoneSafetyMode]);

  useEffect(() => {
    if (!roleFocusRequest) {
      return;
    }

    const attribute = {
      select: "data-account-role-select",
      reason: "data-account-role-reason",
      alert: "data-account-role-alert",
    }[roleFocusRequest.target];
    let attempts = 0;
    const intervalId = window.setInterval(() => {
      const matches = Array.from(
        document.querySelectorAll<HTMLElement>(`[${attribute}]`),
      ).filter(
        (element) => element.dataset.accountUserId === roleFocusRequest.userId,
      );
      const target =
        matches.find((element) => element.getClientRects().length > 0) ?? matches[0];
      if (target) {
        target.focus();
      }
      attempts += 1;
      if (target === document.activeElement || attempts >= 10) {
        window.clearInterval(intervalId);
        setRoleFocusRequest(null);
      }
    }, 30);

    return () => window.clearInterval(intervalId);
  }, [roleFocusRequest, users]);

  useEffect(() => {
    if (!focusUserId || !users.some((user) => user.id === focusUserId)) {
      return;
    }

    let attempts = 0;
    const intervalId = window.setInterval(() => {
      const target = document.getElementById(`account-row-${focusUserId}`);
      if (!target) {
        return;
      }

      target.focus();
      attempts += 1;
      if (document.activeElement === target || attempts >= 10) {
        window.clearInterval(intervalId);
        setFocusUserId(null);
      }
    }, 30);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [focusUserId, users]);

  const closeDrawer = useCallback(() => {
    if (pending || pendingRoleUserId) {
      return;
    }

    setOpen(false);
    setFieldErrors({});
    setFormError(null);
  }, [pending, pendingRoleUserId]);

  function updateValue(field: FieldName, value: string) {
    setValues((current) => ({
      ...current,
      [field]: field === "role" ? (value as UserRole) : value,
    }));
  }

  function describedBy(field: FieldName) {
    return fieldErrors[field] ? `${field}-error` : undefined;
  }

  function roleStateFor(user: AccountRow) {
    return roleEditorStates[user.id] ?? emptyRoleEditorState(user.role);
  }

  function changeSelectedRole(user: AccountRow, selectedRole: UserRole) {
    if (selectedRole === user.role) {
      setRoleEditorStates((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
      return;
    }

    setRoleEditorStates((current) => {
      const existing = current[user.id] ?? emptyRoleEditorState(user.role);
      return {
        ...current,
        [user.id]: {
          ...existing,
          selectedRole,
          phase: "dirty",
          fieldError: null,
          operationError: null,
        },
      };
    });
  }

  function changeRoleReason(user: AccountRow, reason: string) {
    setRoleEditorStates((current) => {
      const existing = current[user.id] ?? emptyRoleEditorState(user.role);
      return {
        ...current,
        [user.id]: {
          ...existing,
          reason,
          phase: "dirty",
          fieldError: null,
          operationError: null,
        },
      };
    });
  }

  function cancelRoleChange(userId: string) {
    setRoleEditorStates((current) => {
      const next = { ...current };
      delete next[userId];
      return next;
    });
    setRoleFocusRequest({ userId, target: "select" });
  }

  function setRoleFailure(
    userId: string,
    state: RoleEditorState,
    operationError: AccountRoleChangeFailure,
    target: "reason" | "alert",
  ) {
    setPendingRoleUserId(null);
    setRoleEditorStates((current) => ({
      ...current,
      [userId]: {
        ...state,
        phase: "error",
        fieldError:
          operationError.fieldErrors?.reason ??
          (operationError.code === "VALIDATION_ERROR"
            ? operationError.message
            : null),
        operationError: target === "alert" ? operationError : null,
      },
    }));
    setRoleFocusRequest({ userId, target });
  }

  async function submitRoleChange(user: AccountRow) {
    if (pendingRoleUserId || pending) {
      return;
    }
    const state = roleStateFor(user);
    const parsed = changeAccountRoleInputSchema.safeParse({
      userId: user.id,
      expectedRole: user.role,
      newRole: state.selectedRole,
      reason: state.reason,
    });
    if (!parsed.success) {
      const reasonError = parsed.error.flatten().fieldErrors.reason?.[0];
      setRoleFailure(
        user.id,
        state,
        {
          code: "VALIDATION_ERROR",
          message: reasonError ?? ACCOUNT_ROLE_CHANGE_COPY.VALIDATION_ERROR,
          fieldErrors: {
            reason: reasonError ?? ACCOUNT_ROLE_CHANGE_COPY.VALIDATION_ERROR,
          },
        },
        "reason",
      );
      return;
    }

    setNotice(null);
    setPendingRoleUserId(user.id);
    setRoleEditorStates((current) => ({
      ...current,
      [user.id]: { ...state, reason: parsed.data.reason, phase: "pending" },
    }));

    let result: ChangeAccountRoleActionResult;
    try {
      result = await changeAccountRoleAction(parsed.data);
    } catch {
      setRoleFailure(
        user.id,
        { ...state, reason: parsed.data.reason },
        {
          code: "INTERNAL_ERROR",
          message: ACCOUNT_ROLE_CHANGE_COPY.INTERNAL_ERROR,
        },
        "alert",
      );
      return;
    }

    if (result.ok) {
      setPendingRoleUserId(null);
      setRoleEditorStates((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
      setRoleOverrides((current) => ({
        ...current,
        [user.id]: result.data.newRole,
      }));
      if (result.data.actorMustRelogin) {
        navigateToSignIn("/?reason=role-changed");
        return;
      }
      setNotice(result.notice);
      setRoleFocusRequest({ userId: user.id, target: "select" });
      router.refresh();
      return;
    }

    if (result.code === "AUTH_EXPIRED") {
      setPendingRoleUserId(null);
      navigateToSignIn(
        "/?reason=session-expired&returnTo=%2Fadministration%3Fsection%3Daccounts",
      );
      return;
    }

    if (result.code === "NOT_FOUND") {
      setPendingRoleUserId(null);
      setRoleEditorStates((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
      router.refresh();
      return;
    }

    if (result.code === "STATE_CHANGED" && result.currentRole) {
      setPendingRoleUserId(null);
      setRoleOverrides((current) => ({
        ...current,
        [user.id]: result.currentRole!,
      }));
      if (result.currentRole === state.selectedRole) {
        setRoleEditorStates((current) => {
          const next = { ...current };
          delete next[user.id];
          return next;
        });
        setNotice(`${user.displayName}'s role is now ${formatRoleLabel(result.currentRole)}.`);
        setRoleFocusRequest({ userId: user.id, target: "select" });
      } else {
        setRoleFailure(user.id, state, result, "alert");
      }
      router.refresh();
      return;
    }

    setRoleFailure(
      user.id,
      { ...state, reason: parsed.data.reason },
      result,
      result.fieldErrors?.reason ? "reason" : "alert",
    );
  }

  async function submitAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || pendingRoleUserId) {
      return;
    }

    const nextErrors = fieldErrorsFromSchema(values);
    setFieldErrors(nextErrors ?? {});
    setFormError(null);
    setNotice(null);

    if (nextErrors) {
      return;
    }

    setPending(true);

    try {
      const result = await createUserAction(values);
      if (!result.ok) {
        setFieldErrors((result.fieldErrors ?? {}) as Partial<Record<FieldName, string>>);
        setFormError(result.fieldErrors ? null : result.message);
        return;
      }

      const createdUser = result.data.user;
      if (createdUser) {
        setAddedUsers((current) => prependAccountRow(toAccountRow(createdUser), current));
      }
      setValues(emptyValues());
      setFieldErrors({});
      setFormError(null);
      setNotice(result.notice ?? null);
      setFocusUserId(createdUser?.id ?? result.data.userId ?? null);
      setOpen(false);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel panel-strong administration-section stack" aria-labelledby="accounts-heading">
      <div className="panel-inner stack administration-section__body">
        <div className="administration-section__header">
          <div className="stack-tight">
            <p className="eyebrow">Accounts</p>
            <h2 className="section-title" id="accounts-heading" tabIndex={-1}>
              Institutional accounts
            </h2>
            <p className="body-copy">
              Review local users, exact role facts, and governed assignment counts.
            </p>
          </div>
          {!phoneSafetyMode ? (
            <button
              className="button button-primary interactive-target"
              disabled={Boolean(pendingRoleUserId)}
              onClick={() => {
                setOpen(true);
                setFormError(null);
                setFieldErrors({});
              }}
              type="button"
            >
              Create account
            </button>
          ) : null}
        </div>

        {notice ? (
          <p aria-live="polite" className="administration-status" role="status">
            {notice}
          </p>
        ) : null}

        <form action="/administration" className="administration-search" method="get">
          <input name="section" type="hidden" value="accounts" />
          <label className="field" htmlFor="accounts-query">
            <span className="field-label">Search accounts</span>
            <input
              defaultValue={model.query}
              id="accounts-query"
              name="query"
              role="searchbox"
              type="search"
            />
          </label>
          <button className="button button-secondary interactive-target" type="submit">
            Search
          </button>
        </form>

        <div className="administration-table-wrap">
          <table className="administration-table">
            <thead>
              <tr>
                {model.columns.map((column) => (
                  <th key={column.id} scope="col">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <th scope="row">
                    <span id={`account-row-${user.id}`} tabIndex={-1}>
                      {user.displayName}
                    </span>
                  </th>
                  <td>{user.email}</td>
                  <td>
                    {phoneSafetyMode ? (
                      user.roleLabel
                    ) : (
                      <AccountRoleEditor
                        mutationsDisabled={pending || Boolean(pendingRoleUserId)}
                        onCancel={() => cancelRoleChange(user.id)}
                        onReasonChange={(reason) => changeRoleReason(user, reason)}
                        onSelectedRoleChange={(role) => changeSelectedRole(user, role)}
                        onSubmit={() => void submitRoleChange(user)}
                        presentationId={`table-${user.id}`}
                        state={roleStateFor(user)}
                        user={user}
                      />
                    )}
                  </td>
                  <td>{user.activeAssignmentCount}</td>
                  <td>
                    <time dateTime={user.createdAtIso}>{user.createdAtLabel}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="administration-card-list">
          {users.map((user) => (
            <li className="administration-card-list__item" key={user.id}>
              <article className="administration-card stack-tight">
                <h3 className="card-title">{user.displayName}</h3>
                <p className="body-copy">{user.email}</p>
                <dl className="administration-fact-list">
                  <div>
                    <dt>Role</dt>
                    <dd>
                      {phoneSafetyMode ? (
                        user.roleLabel
                      ) : (
                        <AccountRoleEditor
                          mutationsDisabled={pending || Boolean(pendingRoleUserId)}
                          onCancel={() => cancelRoleChange(user.id)}
                          onReasonChange={(reason) => changeRoleReason(user, reason)}
                          onSelectedRoleChange={(role) => changeSelectedRole(user, role)}
                          onSubmit={() => void submitRoleChange(user)}
                          presentationId={`card-${user.id}`}
                          state={roleStateFor(user)}
                          user={user}
                        />
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Active assignments</dt>
                    <dd>{user.activeAssignmentCount}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>
                      <time dateTime={user.createdAtIso}>{user.createdAtLabel}</time>
                    </dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ul>
      </div>

      <Modal
        backdropClassName="administration-drawer-backdrop"
        onClose={closeDrawer}
        open={open && !phoneSafetyMode && !pendingRoleUserId}
        surfaceClassName="administration-drawer"
        title="Create local account"
      >
        <div className="button-row administration-drawer__actions">
          <button className="button button-secondary" disabled={pending} onClick={closeDrawer} type="button">
            Close
          </button>
        </div>

        <ErrorSummary errors={summaryErrors} />

        <form className="form-grid" noValidate onSubmit={(event) => void submitAccount(event)}>
          <div className="field">
            <label className="field-label" htmlFor={FIELD_CONFIG.displayName.id}>
              Name
            </label>
            <input
              aria-describedby={describedBy("displayName")}
              aria-invalid={fieldErrors.displayName ? true : undefined}
              id={FIELD_CONFIG.displayName.id}
              name="displayName"
              onChange={(event) => updateValue("displayName", event.target.value)}
              required
              type="text"
              value={values.displayName}
            />
            {fieldErrors.displayName ? (
              <p className="field-error-message" id="displayName-error">
                {fieldErrors.displayName}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label className="field-label" htmlFor={FIELD_CONFIG.email.id}>
              Email
            </label>
            <input
              aria-describedby={describedBy("email")}
              aria-invalid={fieldErrors.email ? true : undefined}
              id={FIELD_CONFIG.email.id}
              name="email"
              onChange={(event) => updateValue("email", event.target.value)}
              required
              type="email"
              value={values.email}
            />
            {fieldErrors.email ? (
              <p className="field-error-message" id="email-error">
                {fieldErrors.email}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label className="field-label" htmlFor={FIELD_CONFIG.password.id}>
              Password
            </label>
            <input
              aria-describedby={describedBy("password")}
              aria-invalid={fieldErrors.password ? true : undefined}
              id={FIELD_CONFIG.password.id}
              name="password"
              onChange={(event) => updateValue("password", event.target.value)}
              required
              type="password"
              value={values.password}
            />
            {fieldErrors.password ? (
              <p className="field-error-message" id="password-error">
                {fieldErrors.password}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label className="field-label" htmlFor={FIELD_CONFIG.role.id}>
              Role
            </label>
            <select
              aria-describedby={describedBy("role")}
              aria-invalid={fieldErrors.role ? true : undefined}
              id={FIELD_CONFIG.role.id}
              name="role"
              onChange={(event) => updateValue("role", event.target.value)}
              value={values.role}
            >
              {USER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            {fieldErrors.role ? (
              <p className="field-error-message" id="role-error">
                {fieldErrors.role}
              </p>
            ) : null}
          </div>

          {formError ? (
            <p className="field-error-message" role="alert">
              {formError}
            </p>
          ) : null}

          <button className="button button-primary" disabled={pending} type="submit">
            {pending ? "Creating account..." : "Create local account"}
          </button>
        </form>
      </Modal>
    </section>
  );
}
