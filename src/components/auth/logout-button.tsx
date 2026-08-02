"use client";

import { useTransition } from "react";
import { signOut } from "next-auth/react";

export function LogoutButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      className="button button-quiet interactive-target"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await signOut({
            callbackUrl: "/?reason=logged-out",
          });
        });
      }}
      type="button"
    >
      {isPending ? "Signing out..." : "Sign out"}
    </button>
  );
}
