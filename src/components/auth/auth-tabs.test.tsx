// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AuthTabs } from "./auth-tabs";

afterEach(cleanup);

const SIGN_UP_HREF = "/?entry=signup";
const SIGN_IN_HREF = "/?entry=signin";

function renderTabs(initialEntry: "signup" | "signin" = "signin") {
  return render(
    <AuthTabs
      initialEntry={initialEntry}
      signInHref={SIGN_IN_HREF}
      signInPane={<p>Returning session pane</p>}
      signUpHref={SIGN_UP_HREF}
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

  it("renders each door as a real link so it works without JavaScript", () => {
    renderTabs("signin");

    expect(screen.getByRole("tab", { name: "Sign up" })).toHaveAttribute(
      "href",
      SIGN_UP_HREF,
    );
    expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute(
      "href",
      SIGN_IN_HREF,
    );
  });

  it("switches panes on click without navigating, and wires tab to tabpanel", async () => {
    const user = userEvent.setup();
    renderTabs("signin");
    const urlBeforeClick = window.location.href;

    await user.click(screen.getByRole("tab", { name: "Sign up" }));

    expect(screen.getByText("First-time admission pane")).toBeVisible();
    expect(screen.getByText("Returning session pane")).not.toBeVisible();
    expect(window.location.href).toBe(urlBeforeClick);

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

  it("Space toggles the focused door like the buttons did", async () => {
    const user = userEvent.setup();
    renderTabs("signin");

    screen.getByRole("tab", { name: "Sign in" }).focus();
    await user.keyboard("{ }");

    // Space on the selected door keeps it selected without navigating.
    expect(screen.getByRole("tab", { name: "Sign in" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Returning session pane")).toBeVisible();
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
        signInHref={SIGN_IN_HREF}
        signInPane={<p>Returning session pane</p>}
        signUpHref={SIGN_UP_HREF}
        signUpPane={<p>First-time admission pane</p>}
      />,
    );

    expect(screen.getByText("First-time admission pane")).toBeVisible();

    rerender(
      <AuthTabs
        initialEntry="signin"
        signInHref={SIGN_IN_HREF}
        signInPane={<p>Returning session pane</p>}
        signUpHref={SIGN_UP_HREF}
        signUpPane={<p>First-time admission pane</p>}
      />,
    );

    expect(screen.getByText("Returning session pane")).toBeVisible();
  });
});

// No-JS contract: the server-rendered HTML alone must present the requested
// door as selected with its pane visible, and the doors must be real links.
function renderServerMarkup(initialEntry: "signup" | "signin") {
  const container = document.createElement("div");
  container.innerHTML = renderToString(
    <AuthTabs
      initialEntry={initialEntry}
      signInHref={SIGN_IN_HREF}
      signInPane={<p>Returning session pane</p>}
      signUpHref={SIGN_UP_HREF}
      signUpPane={<p>First-time admission pane</p>}
    />,
  );
  return container;
}

describe("AuthTabs server rendering (no JavaScript)", () => {
  it("renders the doors as links carrying the entry hrefs", () => {
    const container = renderServerMarkup("signin");

    expect(container.querySelector("#__nonexistent__")).toBeNull();
    const tabs = container.querySelectorAll<HTMLAnchorElement>('a[role="tab"]');
    expect(tabs).toHaveLength(2);
    const hrefs = Array.from(tabs).map((tab) => tab.getAttribute("href"));
    expect(hrefs).toEqual([SIGN_UP_HREF, SIGN_IN_HREF]);
  });

  it("renders the Sign-up door selected with its pane visible when entry=signup", () => {
    const container = renderServerMarkup("signup");

    const signUpTab = container.querySelector('[aria-selected="true"]');
    expect(signUpTab?.textContent).toBe("Sign up");
    expect(container.querySelector('[aria-selected="false"]')?.textContent).toBe("Sign in");

    const signUpPanel = container.querySelector('[id$="-panel-signup"]');
    const signInPanel = container.querySelector('[id$="-panel-signin"]');
    expect(signUpPanel?.hasAttribute("hidden")).toBe(false);
    expect(signUpPanel?.textContent).toContain("First-time admission pane");
    expect(signInPanel?.hasAttribute("hidden")).toBe(true);
    expect(signInPanel?.textContent).toContain("Returning session pane");
  });

  it("renders the Sign-in door selected with the Sign-up pane hidden when entry=signin", () => {
    const container = renderServerMarkup("signin");

    const signInTab = container.querySelector('[aria-selected="true"]');
    expect(signInTab?.textContent).toBe("Sign in");

    const signUpPanel = container.querySelector('[id$="-panel-signup"]');
    const signInPanel = container.querySelector('[id$="-panel-signin"]');
    expect(signUpPanel?.hasAttribute("hidden")).toBe(true);
    expect(signInPanel?.hasAttribute("hidden")).toBe(false);
  });
});
