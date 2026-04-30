import { LogoutButton } from "@/components/auth/logout-button";
import { SuperscriberLogo } from "@/components/brand/superscriber-logo";
import { Principal } from "@/domain/models";
import { formatRoleLabel } from "@/lib/format";

export function SessionBar({ principal }: { principal: Principal }) {
  return (
    <section className="panel session-shell">
      <div className="panel-inner-tight session-bar">
        <div className="session-copy">
          <SuperscriberLogo size="sm" />
          <p className="eyebrow">Local account session</p>
          <div className="session-meta-inline">
            <strong>{principal.displayName}</strong>
            <span className="field-note">{principal.email}</span>
            <span className="field-note">{formatRoleLabel(principal.role)}</span>
          </div>
        </div>

        <div className="session-actions">
          <LogoutButton />
        </div>
      </div>
    </section>
  );
}
