"use client";

import { useEffect } from "react";

/**
 * Self-heal for stale build tabs: after a redeploy/restart, a long-lived tab
 * can hold chunk URLs that the new server no longer serves; dynamic imports
 * then reject and controls go silently dead (unreachable actions, dialogs
 * that "do nothing"). One guarded reload converges the tab on the live
 * build; the sessionStorage marker prevents reload loops.
 */
const MARKER = "superscriber.chunk-reload-at";
const MIN_INTERVAL_MS = 30_000;

function defaultReload() {
  window.location.reload();
}

function isChunkFailure(text: string) {
  return /ChunkLoadError|dynamically imported module|Failed to fetch.*chunk|error loading chunk/i.test(
    text,
  );
}

export function ChunkReloadGuard({ reload = defaultReload }: { reload?: () => void }) {
  useEffect(() => {
    const maybeReload = (raw: unknown) => {
      const message =
        typeof raw === "string"
          ? raw
          : raw instanceof Error
            ? `${raw.name} ${raw.message}`
            : String((raw as { message?: string })?.message ?? raw ?? "");

      if (!isChunkFailure(message)) {
        return;
      }

      let last = 0;
      try {
        last = Number(sessionStorage.getItem(MARKER) ?? 0);
      } catch {
        // Storage blocked (privacy mode, disabled cookies): treat as no marker.
      }
      const now = Date.now();
      if (now - last < MIN_INTERVAL_MS) {
        return;
      }

      try {
        sessionStorage.setItem(MARKER, String(now));
      } catch {
        // Storage blocked: proceed anyway; a reload loop is the lesser harm
        // compared to a permanently dead tab.
      }
      reload();
    };

    const onError = (event: ErrorEvent) => {
      maybeReload(event.message);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      maybeReload(event.reason);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [reload]);

  return null;
}
