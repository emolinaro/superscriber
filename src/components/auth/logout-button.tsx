"use client";

import { useTransition } from "react";
import { signOut } from "next-auth/react";
import { markIntentionalSignOut } from "@/lib/signed-out-marker";
import { revokeCurrentSessionAction } from "@/server/actions/auth-actions";

export function LogoutButton({ label = "Sign out" }: { label?: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      className="button button-quiet interactive-target"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          markIntentionalSignOut();
          // Revoke the durable session row before clearing the cookie (6.4.1).
          await revokeCurrentSessionAction();
          await signOut({
            callbackUrl: "/?reason=logged-out",
            redirect: true,
          });
        });
      }}
      type="button"
    >
      {isPending ? "Signing out..." : label}
    </button>
  );
}
