import { logoutAction, switchRoleAction } from "@/app/actions";
import { USER_ROLES, UserRole } from "@/domain/models";
import { formatRoleLabel } from "@/lib/format";

export function SessionBar({ activeRole }: { activeRole: UserRole }) {
  return (
    <section className="panel">
      <div className="panel-inner-tight session-bar">
        <div className="stack-tight">
          <strong>Demo session</strong>
          <span className="field-note">
            Role cookie is the only auth layer in this implementation slice.
          </span>
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
