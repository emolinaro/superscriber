import { AppShell } from "@/components/shell/app-shell";
import { requireActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const principal = await requireActivePrincipal();

  return <AppShell principal={principal}>{children}</AppShell>;
}
