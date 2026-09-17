import { redirect } from "next/navigation";
import { MandatoryPasswordChange } from "@/components/account/mandatory-password-change";
import { sanitizeReturnTo } from "@/lib/safe-return-to";
import { getActiveSession } from "@/server/session";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PasswordChangePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await getActiveSession();
  if (!session) redirect("/?reason=session-expired");
  if (!session.mustChangePassword) redirect("/workspace");
  const params = await searchParams;
  const returnTo = sanitizeReturnTo(firstValue(params.returnTo) ?? "/workspace");

  return (
    <div className="shell shell-narrow stack">
      <MandatoryPasswordChange userId={session.user.userId} returnTo={returnTo} />
    </div>
  );
}
