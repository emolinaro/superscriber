// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthSurface } from "./auth-surface";

afterEach(cleanup);

describe("AuthSurface", () => {
  it("keeps the form content first in the DOM and focuses the heading when requested", async () => {
    const { container } = render(
      <AuthSurface
        description="Use your local account to continue."
        focusHeading
        heading="Sign in"
        notice={{ tone: "ok", message: "Your session ended safely." }}
        support={<p>Support panel</p>}
      >
        <form aria-label="Sign in form">
          <button type="submit">Continue</button>
        </form>
      </AuthSurface>,
    );

    const primary = container.querySelector(".auth-surface__primary");
    const support = container.querySelector(".auth-surface__support");
    expect(primary?.compareDocumentPosition(support as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Sign in" })).toHaveFocus();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Your session ended safely.");
  });

  it("carries the Superscriber wordmark above the heading so every auth mode is branded", () => {
    const { container } = render(
      <AuthSurface
        description="Create the first administrator."
        heading="First-run setup"
        support={<p>Support panel</p>}
      >
        <p>Form area</p>
      </AuthSurface>,
    );

    const primary = container.querySelector(".auth-surface__primary");
    expect(primary).not.toBeNull();
    const logo = primary!.querySelector(".superscriber-logo");
    expect(logo).not.toBeNull();
    expect(logo).toHaveClass("superscriber-logo-light", "superscriber-logo-md");
    expect(screen.queryByLabelText("Superscriber")).not.toBeNull();
    expect(logo!.querySelector(".superscriber-logo-name")).toHaveAttribute(
      "aria-label",
      "Superscriber",
    );
    // The optional descriptor's locked color fails WCAG AA on the paper card,
    // so the auth surface keeps the brand's default (descriptor off).
    expect(logo!.querySelector(".superscriber-logo-descriptor")).toBeNull();

    const heading = screen.getByRole("heading", { name: "First-run setup" });
    expect(logo!.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
