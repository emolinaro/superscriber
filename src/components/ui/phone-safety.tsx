"use client";

import { useEffect, useState, type ReactNode } from "react";

export function isPhoneSafetyMode(input: {
  width: number;
  height: number;
  coarsePointer: boolean;
}) {
  return input.width < 768 || (input.coarsePointer && input.height < 768);
}

function readPhoneSafetyMode() {
  return isPhoneSafetyMode({
    width: window.innerWidth,
    height: window.innerHeight,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  });
}

export function usePhoneSafetyMode() {
  const [phoneSafetyMode, setPhoneSafetyMode] = useState(true);

  useEffect(() => {
    const coarsePointerQuery = window.matchMedia("(pointer: coarse)");

    function update() {
      setPhoneSafetyMode(readPhoneSafetyMode());
    }

    const rafId = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);

    if (typeof coarsePointerQuery.addEventListener === "function") {
      coarsePointerQuery.addEventListener("change", update);
    } else {
      coarsePointerQuery.addListener(update);
    }

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", update);

      if (typeof coarsePointerQuery.removeEventListener === "function") {
        coarsePointerQuery.removeEventListener("change", update);
      } else {
        coarsePointerQuery.removeListener(update);
      }
    };
  }, []);

  return phoneSafetyMode;
}

export function PhoneSafetyGuard({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const phoneSafetyMode = usePhoneSafetyMode();

  return phoneSafetyMode ? fallback : children;
}
