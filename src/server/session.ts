import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { USER_ROLES, UserRole } from "@/domain/models";

const COOKIE_NAME = "superscriber-role";

export async function getActiveRole(): Promise<UserRole | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  return USER_ROLES.includes(raw as UserRole) ? (raw as UserRole) : null;
}

export async function requireActiveRole() {
  const role = await getActiveRole();
  if (!role) {
    redirect("/");
  }

  return role;
}

export async function setActiveRole(role: UserRole) {
  const store = await cookies();
  store.set(COOKIE_NAME, role, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
  });
}

export async function clearActiveRole() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

