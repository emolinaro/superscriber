"use client";

import { useEffect, useRef, useState } from "react";
import { LogoutButton } from "@/components/auth/logout-button";
import type { Principal } from "@/domain/models";
import { formatRoleLabel } from "@/lib/format";

export function AccountMenu({ principal }: { principal: Principal }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-label="Open account menu"
        className="account-menu__trigger interactive-target"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="account-menu__trigger-label">Account</span>
      </button>
      {open ? (
        <div className="account-menu__surface">
          <div className="account-menu__meta">
            <strong>{principal.displayName}</strong>
            <span>{principal.email}</span>
            <span>{formatRoleLabel(principal.role)}</span>
          </div>
          <LogoutButton />
        </div>
      ) : null}
    </div>
  );
}
