// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthPaneHeading } from "./auth-pane-heading";

afterEach(cleanup);

describe("AuthPaneHeading", () => {
  it("focuses itself on mount when a notice requests heading focus", async () => {
    render(<AuthPaneHeading focusOnMount>Sign in</AuthPaneHeading>);
    expect(screen.getByRole("heading", { name: "Sign in" })).toHaveFocus();
  });

  it("stays unfocused without a focus request", () => {
    render(<AuthPaneHeading>First-run setup</AuthPaneHeading>);
    expect(screen.getByRole("heading", { name: "First-run setup" })).not.toHaveFocus();
  });
});
