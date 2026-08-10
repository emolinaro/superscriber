"use client";

import { useEffect, useRef, useState } from "react";
import { LogoutButton } from "@/components/auth/logout-button";
import type { Principal } from "@/domain/models";
import { formatRoleLabel } from "@/lib/format";
import { useThemePreference, type ThemePreference } from "@/lib/theme";

const THEME_CHOICES: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AccountMenu({ principal }: { principal: Principal }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useThemePreference();

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
          {/* Per-user appearance override. A personal preference, not a
             governed mutation: the server copy survives across devices,
             localStorage gives the no-flash first paint. */}
          <fieldset className="account-menu__appearance">
            <legend>Appearance</legend>
            <div
              className="account-menu__appearance-options"
              role="presentation"
            >
              {THEME_CHOICES.map((choice) => (
                <label
                  key={choice.value}
                  className="account-menu__appearance-option"
                >
                  <input
                    checked={theme === choice.value}
                    name="appearance"
                    onChange={() => setTheme(choice.value)}
                    type="radio"
                  />
                  <span>{choice.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <LogoutButton />
        </div>
      ) : null}
    </div>
  );
}
