// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountPage } from "./account-page";
const phone = vi.hoisted(() => ({ value: false }));
vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => phone.value,
}));
afterEach(cleanup);
const account = {
  id: "self",
  displayName: "Current User",
  email: "self@example.com",
  role: "admin" as const,
  isActive: true,
  mustChangePassword: false,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};
it("shows the user's own account facts and lifecycle guidance", () => {
  phone.value = false;
  render(<AccountPage account={account} />);
  expect(screen.getByRole("heading", { name: "Your account" })).toBeVisible();
  expect(screen.getByText(account.email)).toBeVisible();
  expect(screen.getByText("Active")).toBeVisible();
  expect(
    screen.getByText(/only an administrator can reactivate/),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open account administration" }),
  ).toHaveAttribute("href", "/administration?section=accounts");
});
it("withholds administration navigation and mutations on phones", () => {
  phone.value = true;
  render(<AccountPage account={account} />);
  expect(screen.getByRole("status")).toHaveTextContent("read-only");
  expect(
    screen.queryByRole("link", { name: "Open account administration" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
