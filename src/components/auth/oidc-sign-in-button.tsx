"use client";

import { useTransition } from "react";
import { signIn } from "next-auth/react";
import { sanitizeReturnTo } from "@/lib/safe-return-to";

/**
 * Institutional (Authentik OIDC) sign-in. Available in `dual` and
 * `authentik-primary` modes next to or instead of the local credentials form.
 * Access is decided server-side by the admission resolver; this button only
 * starts the redirect flow and the post-login path re-checks authorization.
 */
export function OidcSignInButton({ returnTo = "/workspace" }: { returnTo?: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <div className="stack-tight">
      <button
        className="button button-primary"
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            const callbackUrl = `/?returnTo=${encodeURIComponent(sanitizeReturnTo(returnTo))}`;
            await signIn("authentik", { callbackUrl });
          });
        }}
        type="button"
      >
        {isPending ? "Opening institutional sign-in..." : "Sign in with institutional account"}
      </button>
    </div>
  );
}
