import Link from "next/link";
import { PasswordResetRequestForm } from "@/components/auth/password-reset-request-form";
import { requestPasswordResetAction } from "@/server/actions/password-reset-actions";

export const dynamic = "force-dynamic";

export default function ResetRequestPage() {
  return (
    <main className="auth-shell">
      <section className="panel panel-strong auth-shell__card">
        <div className="panel-inner stack">
          <h1>Reset your password</h1>
          <p>
            Enter the email for your account. If mail delivery is not set up, an
            administrator can reset your password for you.
          </p>
          <PasswordResetRequestForm action={requestPasswordResetAction} />
          <p>
            <Link href="/">Back to sign in</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
