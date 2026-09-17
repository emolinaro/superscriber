import { redirect } from "next/navigation";
import { requireActivePrincipal } from "@/server/session";
import { getUserById } from "@/server/auth/service";
import { AccountPage } from "@/components/account/account-page";
export const dynamic = "force-dynamic";
export default async function Page() {
  const principal = await requireActivePrincipal("/account");
  const account = await getUserById(principal.userId);
  if (!account?.isActive) redirect("/?reason=session-expired");
  return <AccountPage account={account} />;
}
