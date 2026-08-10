"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Theme state lives twice:
//  1. localStorage ("superscriber.theme"): read pre-paint by the layout
//     bootstrap script so the first frame is already correct;
//  2. users.theme_preference (server, durable per-user): synced by this hook
//     - GET on shell mount seeds fresh devices, POST on change persists.
//     A stored local choice that disagrees with the server (an earlier
//     POST failed) wins and is re-POSTed so the server self-heals.
// Values: "system" (follow OS) | "light" | "dark". data-theme on <html> is
// the rendering contract (tokens.css); "system" removes the attribute.

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "superscriber.theme";

export function readBootTheme(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return "system";
  }
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function applyThemeToDocument(theme: ThemePreference) {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
  root.style.colorScheme = theme === "system" ? "" : theme;
}

function postThemePreference(value: ThemePreference) {
  void fetch("/api/preferences/theme", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ themePreference: value }),
  }).catch(() => undefined);
}

export function useThemePreference() {
  const [theme, setThemeState] = useState<ThemePreference>("system");
  // Local-mutation counter: setTheme bumps it, and the GET resolution
  // compares against the value captured when its fetch started. After a
  // user pick, state and localStorage agree again, so a stale state/"boot"
  // comparison cannot detect the race - the version can.
  const localVersionRef = useRef(0);

  // First paint is the bootstrap's copy; on mount we read it back so the UI
  // and DOM agree even before the server sync lands.
  useEffect(() => {
    setThemeState(readBootTheme());

    let cancelled = false;
    const versionAtStart = localVersionRef.current;
    void fetch("/api/preferences/theme", { cache: "no-store" })
      .then(async (response) => (response.ok ? await response.json() : null))
      .then((body: { themePreference?: string } | null) => {
        if (cancelled || !body) {
          return;
        }
        if (localVersionRef.current !== versionAtStart) {
          // The local copy won a race while the fetch was in flight - the
          // newest local intent wins and its setter already fired the POST.
          return;
        }
        const value =
          body.themePreference === "light" || body.themePreference === "dark"
            ? body.themePreference
            : "system";
        let stored: string | null = null;
        try {
          stored = window.localStorage.getItem(STORAGE_KEY);
        } catch {
          stored = null;
        }
        const local =
          stored === "light" || stored === "dark" || stored === "system"
            ? stored
            : null;
        if (local === null) {
          // No prior local choice: the server copy seeds this device.
          setThemeState(value);
          if (stored !== null || value !== "system") {
            window.localStorage.setItem(STORAGE_KEY, value);
            applyThemeToDocument(value);
          }
          return;
        }
        setThemeState(local);
        if (local !== value) {
          // The stored local choice never reached the server (its POST
          // failed); keep it visible and re-POST so the server self-heals.
          postThemePreference(local);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useCallback((value: ThemePreference) => {
    localVersionRef.current += 1;
    setThemeState(value);
    window.localStorage.setItem(STORAGE_KEY, value);
    applyThemeToDocument(value);
    postThemePreference(value);
  }, []);

  return { theme, setTheme };
}
