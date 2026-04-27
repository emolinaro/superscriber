import { logoutAction, switchRoleAction } from "@/app/actions";
import { USER_ROLES, UserRole } from "@/domain/models";
import { formatRoleLabel } from "@/lib/format";

export function SessionBar({ activeRole }: { activeRole: UserRole }) {
  return (
    <section className="panel session-shell">
      <div className="panel-inner-tight session-bar">
        <div className="session-copy">
          <p className="eyebrow">Demo session</p>
          <div className="session-meta-inline">
            <strong>{formatRoleLabel(activeRole)}</strong>
            <span className="field-note">Cookie auth only in this implementation slice.</span>
          </div>
        </div>

        <div className="session-actions">
          <div className="role-switch-row">
            {USER_ROLES.map((role) => (
              <form key={role} action={switchRoleAction}>
                <input type="hidden" name="role" value={role} />
                <button
                  className={`button ${role === activeRole ? "button-primary" : "button-secondary"}`}
                  disabled={role === activeRole}
                  type="submit"
                >
                  {formatRoleLabel(role)}
                </button>
              </form>
            ))}
          </div>
          <form action={logoutAction}>
            <button className="button button-quiet" type="submit">
              Leave session
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
