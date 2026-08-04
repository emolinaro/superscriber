import { AppShell } from "@/components/shell/app-shell";
import { getActiveSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getActiveSession();

  return session ? (
    <AppShell principal={session.user} emergency={session.emergency}>
      {children}
    </AppShell>
  ) : (
    children
  );
}
