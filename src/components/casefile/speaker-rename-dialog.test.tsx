// @vitest-environment jsdom

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@/domain/models";
import { SpeakerRenameDialog } from "./speaker-rename-dialog";

function segment(id: string, speakerLabel: string): TranscriptSegment {
  return { id, speakerLabel, startMs: 0, endMs: 1_000, text: id, confidence: 0.9 };
}

const segments = [
  segment("seg-1", "Speaker A"),
  segment("seg-2", "Speaker B"),
  segment("seg-3", "Speaker A"),
  segment("seg-4", "Speaker B"),
];

function renderDialog(
  onConfirm = vi.fn().mockResolvedValue({ ok: true }),
  dialogSegments = segments,
) {
  const appRoot = document.createElement("div");
  appRoot.id = "app-root";
  document.body.append(appRoot);

  render(
    <SpeakerRenameDialog
      onCancel={vi.fn()}
      onConfirm={onConfirm}
      open
      segments={dialogSegments}
    />,
    { container: appRoot },
  );

  return { onConfirm };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SpeakerRenameDialog", () => {
  it("lists current speakers with segment counts", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Rename speaker everywhere" })).toBeVisible();
    const from = screen.getByLabelText("Current speaker");
    expect(from).toHaveValue("Speaker A");
    expect(screen.getByRole("option", { name: "Speaker A (2 segments)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Speaker B (2 segments)" })).toBeInTheDocument();
  });

  it("keeps the confirm button disabled until a valid new name is entered", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "Rename speaker" })).toBeDisabled();
    expect(screen.queryByTestId("speaker-rename-summary")).not.toBeInTheDocument();
  });

  it("shows the pre-commit batch summary once a new name is entered", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("New speaker name"), "Dana");

    expect(screen.getByTestId("speaker-rename-summary")).toHaveTextContent(
      'Renamed "Speaker A" to "Dana" across 2 segments.',
    );
    expect(screen.getByRole("button", { name: "Rename speaker" })).toBeEnabled();
  });

  it("names the merge when the new name matches an existing speaker", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText("Current speaker"), "Speaker B");
    await user.type(screen.getByLabelText("New speaker name"), "Speaker A");

    expect(screen.getByTestId("speaker-rename-summary")).toHaveTextContent(
      'Renamed "Speaker B" to "Speaker A" across 2 segments. Merged with existing "Speaker A" (2 segments).',
    );
  });

  it("surfaces a warning when the new name matches the current speaker", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("New speaker name"), "Speaker A");

    expect(
      screen.getByText("Choose a speaker name different from the current one."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Rename speaker" })).toBeDisabled();
  });

  it("confirms with the trimmed from/to labels", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.selectOptions(screen.getByLabelText("Current speaker"), "Speaker B");
    await user.type(screen.getByLabelText("New speaker name"), "  Dana  ");
    await user.click(screen.getByRole("button", { name: "Rename speaker" }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({ fromSpeaker: "Speaker B", toSpeaker: "Dana" }),
    );
  });

  it("confirms an empty legacy source through exact existence lookup", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue({ ok: true });
    renderDialog(onConfirm, [segment("legacy-1", "")]);

    await user.type(screen.getByLabelText("New speaker name"), "Dana");

    expect(screen.getByTestId("speaker-rename-summary")).toHaveTextContent(
      'Renamed "" to "Dana" across 1 segment.',
    );
    await user.click(screen.getByRole("button", { name: "Rename speaker" }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({ fromSpeaker: "", toSpeaker: "Dana" }),
    );
  });

  it("renders a failed confirm as an inline error", async () => {
    const user = userEvent.setup();
    renderDialog(vi.fn().mockResolvedValue({ ok: false, error: "This recording changed." }));

    await user.type(screen.getByLabelText("New speaker name"), "Dana");
    await user.click(screen.getByRole("button", { name: "Rename speaker" }));

    expect(await screen.findByText("This recording changed.")).toBeVisible();
  });
});
