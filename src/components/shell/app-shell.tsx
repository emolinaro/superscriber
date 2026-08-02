"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SuperscriberLogo } from "@/components/brand/superscriber-logo";
import type { Principal, UserRole } from "@/domain/models";
import { AccountMenu } from "./account-menu";

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

export function AppShell({
  principal,
  children,
}: {
  principal: Principal;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/workspace";

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
      <main className="app-shell__main" id="app-main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
