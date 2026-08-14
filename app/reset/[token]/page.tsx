import Link from "next/link";
import { PasswordResetCompletionForm } from "@/components/auth/password-reset-completion-form";
import { completePasswordResetAction } from "@/server/actions/password-reset-actions";

export const dynamic = "force-dynamic";

export default async function ResetCompletePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <main className="auth-shell">
      <section className="panel panel-strong auth-shell__card">
        <div className="panel-inner stack">
          <h1>Choose a new password</h1>
          <PasswordResetCompletionForm token={token} action={completePasswordResetAction} />
          <p>
            <Link href="/">Back to sign in</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
