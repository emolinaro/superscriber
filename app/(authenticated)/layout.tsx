import { AppShell } from "@/components/shell/app-shell";
import { getActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const principal = await getActivePrincipal();

  return principal ? <AppShell principal={principal}>{children}</AppShell> : children;
}
