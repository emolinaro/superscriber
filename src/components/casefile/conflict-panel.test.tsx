// @vitest-environment jsdom

import userEvent from "@testing-library/user-event";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictPanel } from "./conflict-panel";

describe("ConflictPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows loaded and current revision ids, latest link, and discard confirmation", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <ConflictPanel
        conflict={{
          recordingId: "rec-1",
          loadedRevisionId: "rev-1",
          currentRevisionId: "rev-5",
          pendingRevisionId: null,
          approvedRevisionId: null,
          winningStage: "draft_review",
        }}
        latestHref="/recordings/rec-1?revision=rev-5"
        onDiscard={onDiscard}
      />,
    );

    expect(screen.getByText("Loaded revision: rev-1")).toBeVisible();
    expect(screen.getByText("Current revision: rev-5")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open latest revision in a new tab" })).toHaveAttribute(
      "href",
      "/recordings/rec-1?revision=rev-5",
    );

    await user.click(screen.getByRole("button", { name: "Discard local changes and reload latest" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalled();
  });
});
