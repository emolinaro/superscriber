"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SuperscriberLogo } from "@/components/brand/superscriber-logo";
import {
  clearIntentionalSignOut,
} from "@/lib/signed-out-marker";
import { clearSelfResetHold } from "@/lib/self-reset-hold";
import { shouldHoldSessionExpiredRedirect } from "@/lib/session-guard-policy";
import type { Principal, UserRole } from "@/domain/models";
import { AccountMenu } from "./account-menu";
import { LogoutButton } from "@/components/auth/logout-button";

const ROLE_NAV: Record<UserRole, Array<{ href: string; label: string }>> = {
  uploader: [
    { href: "/workspace", label: "Work" },
    { href: "/ingest", label: "Ingest" },
  ],
  reviewer: [{ href: "/workspace", label: "Work" }],
  approver: [{ href: "/workspace", label: "Work" }],
  admin: [
    { href: "/workspace", label: "Work" },
    { href: "/ingest", label: "Ingest" },
    { href: "/administration", label: "Administration" },
  ],
};

function isCurrentPath(pathname: string, href: string) {
  if (href === "/workspace") {
    return pathname === "/workspace" || pathname.startsWith("/recordings/");
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

const SESSION_POLL_INTERVAL_MS = 5_000;

/**
 * Plan section 7.3: an open UI must converge within five seconds after its
 * session is revoked or expires. Transient network failures keep watching;
 * only a definitive inactive answer redirects.
 */
function useSessionGuard() {
  useEffect(() => {
    let cancelled = false;
    // A mounted shell means a fresh authenticated render in this tab: clear
    // any stale intentional-sign-out or self-reset hold markers before the
    // first poll.
    clearIntentionalSignOut();
    clearSelfResetHold();

    const checkSession = async () => {
      if (shouldHoldSessionExpiredRedirect()) {
        // A deliberate sign-out or a held-open self-reset result dialog wins;
        // their own navigation decides where this tab lands.
        return;
      }

      try {
        const response = await fetch("/api/auth/session-state", { cache: "no-store" });
        if (!response.ok) {
          return;
        }

        const body = (await response.json()) as { active?: boolean };
        if (!cancelled && body.active === false) {
          const returnTo = encodeURIComponent(
            `${window.location.pathname}${window.location.search}`,
          );
          window.location.assign(`/?reason=session-expired&returnTo=${returnTo}`);
        }
      } catch {
        // Keep watching; the next interval retries.
      }
    };

    const interval = window.setInterval(checkSession, SESSION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);
}

export type EmergencyBannerState = {
  correlationId: string;
  reason: string;
  absoluteExpiresAt: string;
};

export function AppShell({
  principal,
  emergency,
  children,
}: {
  principal: Principal;
  emergency?: EmergencyBannerState;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/workspace";
  useSessionGuard();

  return (
    <div className="app-shell">
      <a className="skip-link interactive-target" href="#app-main">
        Skip to main content
      </a>
      <header className="app-shell__header">
        <div className="app-shell__header-content">
          <Link className="app-shell__brand" href="/workspace">
            <SuperscriberLogo size="sm" />
          </Link>
          <nav aria-label="Primary" className="app-shell__nav">
            <ul className="app-shell__nav-list">
              {ROLE_NAV[principal.role].map((item) => {
                const current = isCurrentPath(pathname, item.href);

                return (
                  <li key={item.href}>
                    <Link
                      aria-current={current ? "page" : undefined}
                      className="app-shell__nav-link interactive-target"
                      href={item.href}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <AccountMenu principal={principal} />
        </div>
      </header>
      {emergency ? (
        <div className="banner banner-emergency" data-tone="danger" role="alert">
          <strong>Emergency administrator session</strong>
          <span> Activation {emergency.correlationId}.</span>
          <span className="banner-emergency__reason"> {emergency.reason}</span>
          <span> Expires {emergency.absoluteExpiresAt} UTC.</span>{" "}
          <LogoutButton label="End emergency session" />
        </div>
      ) : null}
      <main className="app-shell__main" id="app-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
