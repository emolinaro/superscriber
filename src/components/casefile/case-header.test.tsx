// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCasefile } from "./test-fixtures";
import { CaseHeader } from "./case-header";

import type { CasefileViewModel } from "@/server/casefile/read-model";

describe("CaseHeader", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders kicker, title, and facts inside one header card with a Back to Work exit", () => {
    render(<CaseHeader casefile={createCasefile() as CasefileViewModel} />);

    const header = screen.getByRole("banner");
    expect(header.querySelector(".case-header__body")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Governed recording" })).toBeVisible();
    expect(screen.getByText("Draft review")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to Work" })).toHaveAttribute(
      "href",
      "/workspace",
    );
  });

  it("hosts the governance drawer trigger in the header actions", async () => {
    const user = userEvent.setup();
    const onToggleGovernance = vi.fn();
    render(
      <CaseHeader
        casefile={createCasefile() as CasefileViewModel}
        governanceOpen={false}
        onToggleGovernance={onToggleGovernance}
      />,
    );

    const trigger = screen.getByRole("button", { name: /^Governance/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(onToggleGovernance).toHaveBeenCalledTimes(1);
  });

  it("renders no governance trigger when no toggle handler is provided", () => {
    render(<CaseHeader casefile={createCasefile() as CasefileViewModel} />);

    expect(screen.queryByRole("button", { name: /^Governance/ })).toBeNull();
  });
});
