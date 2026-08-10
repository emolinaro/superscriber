// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AuthTabs } from "./auth-tabs";

afterEach(cleanup);

function renderTabs(initialEntry: "signup" | "signin" = "signin") {
  return render(
    <AuthTabs
      initialEntry={initialEntry}
      signInPane={<p>Returning session pane</p>}
      signUpPane={<p>First-time admission pane</p>}
    />,
  );
}

describe("AuthTabs", () => {
  it("shows a tab pair labelled Sign up / Sign in with one panel visible", () => {
    renderTabs("signin");

    expect(screen.getByRole("tablist", { name: "Account access" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Sign up" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Returning session pane")).toBeVisible();
    expect(screen.getByText("First-time admission pane")).not.toBeVisible();
  });

  it("switches panes on click and wires tab to tabpanel", async () => {
    const user = userEvent.setup();
    renderTabs("signin");

    await user.click(screen.getByRole("tab", { name: "Sign up" }));

    expect(screen.getByText("First-time admission pane")).toBeVisible();
    expect(screen.getByText("Returning session pane")).not.toBeVisible();

    const tab = screen.getByRole("tab", { name: "Sign up" });
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tab.id);
    expect(tab).toHaveAttribute("aria-controls", panel.id);
  });

  it("arrow keys move selection and focus between tabs", async () => {
    const user = userEvent.setup();
    renderTabs("signin");

    const signIn = screen.getByRole("tab", { name: "Sign in" });
    signIn.focus();
    await user.keyboard("{ArrowLeft}");

    const signUp = screen.getByRole("tab", { name: "Sign up" });
    expect(signUp).toHaveFocus();
    expect(signUp).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}");
    expect(signIn).toHaveFocus();
    expect(signIn).toHaveAttribute("aria-selected", "true");
  });

  it("keeps only the selected tab in the tab order", () => {
    renderTabs("signup");

    expect(screen.getByRole("tab", { name: "Sign up" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute("tabindex", "-1");
  });

  it("re-syncs the visible pane when the server-chosen entry changes", () => {
    const { rerender } = render(
      <AuthTabs
        initialEntry="signup"
        signInPane={<p>Returning session pane</p>}
        signUpPane={<p>First-time admission pane</p>}
      />,
    );

    expect(screen.getByText("First-time admission pane")).toBeVisible();

    rerender(
      <AuthTabs
        initialEntry="signin"
        signInPane={<p>Returning session pane</p>}
        signUpPane={<p>First-time admission pane</p>}
      />,
    );

    expect(screen.getByText("Returning session pane")).toBeVisible();
  });
});
