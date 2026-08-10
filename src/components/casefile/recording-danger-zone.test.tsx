// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingDangerZone } from "./recording-danger-zone";

const { mockDelete } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
}));

vi.mock("@/server/actions/administration-actions", () => ({
  deleteRecordingAction: mockDelete,
}));

describe("RecordingDangerZone (demo-governance-bringback)", () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");

  beforeEach(() => {
    mockDelete.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    if (locationDescriptor) {
      Object.defineProperty(window, "location", locationDescriptor);
    }
  });

  it("gates permanent deletion on the typed title and enforces it server-side again", async () => {
    const user = userEvent.setup();
    render(<RecordingDangerZone recordingId="rec-1" title="Quarterly Review" />);

    await user.click(screen.getByRole("button", { name: "Delete recording permanently..." }));

    expect(
      await screen.findByRole("dialog", { name: "Delete this recording permanently?" }),
    ).toBeVisible();

    const confirm = screen.getByRole("button", { name: "Delete permanently" });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText("Type the recording title to confirm"), "quarterly review");
    expect(confirm).toBeDisabled(); // caps matter

    await user.clear(screen.getByLabelText("Type the recording title to confirm"));
    await user.type(screen.getByLabelText("Type the recording title to confirm"), "Quarterly Review");
    expect(confirm).toBeEnabled();

    // Non-matching input can still be rejected by the server; that error is
    // surfaced inline rather than navigating away.
    mockDelete.mockResolvedValueOnce({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Type the recording title exactly to confirm permanent deletion.",
    });
    await user.click(confirm);
    expect(mockDelete).toHaveBeenCalledWith({
      recordingId: "rec-1",
      expectedTitle: "Quarterly Review",
    });
    expect(
      await screen.findByText("Type the recording title exactly to confirm permanent deletion."),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("leaves the deleted casefile via full navigation on success", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign },
    });

    mockDelete.mockResolvedValueOnce({
      ok: true,
      data: { href: "/", userId: "user-admin" },
      notice: 'Permanently deleted "Quarterly Review" and 1 revision; the ledger retains one deletion record and the pre-delete export snapshot.',
    });

    render(<RecordingDangerZone recordingId="rec-1" title="Quarterly Review" />);
    await user.click(screen.getByRole("button", { name: "Delete recording permanently..." }));
    await user.type(
      await screen.findByLabelText("Type the recording title to confirm"),
      "Quarterly Review",
    );
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    // Full unload, not a client-side RSC refresh of a 404'd page.
    expect(assign).toHaveBeenCalledWith("/");
  });
});
