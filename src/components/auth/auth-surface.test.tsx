// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthSurface } from "./auth-surface";

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
});
