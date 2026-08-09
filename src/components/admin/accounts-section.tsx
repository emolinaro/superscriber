"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { USER_ROLES, type UserRole } from "@/domain/models";
import { ErrorSummary } from "@/components/ui/error-summary";
import { Modal } from "@/components/ui/modal";
import type { CommandResult } from "@/lib/command-result";
import { formatDateTimeIso, formatDateTimeUtc, formatRoleLabel } from "@/lib/format";
import type { AccountDirectoryEntry } from "@/server/access/service";
import type { AdministrationAccountsViewModel } from "@/server/administration/service";
import {
  createUserAction as defaultCreateUserAction,
  type AdministrationMutationResult,
  type CreateUserInput,
} from "@/server/actions/administration-actions";
import { localUserSchema } from "@/server/auth/validation";

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

export function AccountsSection({
  model,
  phoneSafetyMode,
  createUserAction = defaultCreateUserAction,
}: {
  model: AdministrationAccountsViewModel;
  phoneSafetyMode: boolean;
  createUserAction?: (
    input: CreateUserInput,
  ) => Promise<CommandResult<AdministrationMutationResult>>;
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

  const users = useMemo(() => mergeAccountRows(model.users, addedUsers), [addedUsers, model.users]);

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
    if (pending) {
      return;
    }

    setOpen(false);
    setFieldErrors({});
    setFormError(null);
  }, [pending]);

  function updateValue(field: FieldName, value: string) {
    setValues((current) => ({
      ...current,
      [field]: field === "role" ? (value as UserRole) : value,
    }));
  }

  function describedBy(field: FieldName) {
    return fieldErrors[field] ? `${field}-error` : undefined;
  }

  async function submitAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
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
                  <td>{user.roleLabel}</td>
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
                    <dd>{user.roleLabel}</dd>
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
        open={open && !phoneSafetyMode}
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
