// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelTierDownloadAction } from "./model-tier-download";

afterEach(() => {
  cleanup();
});

// model-tier-provisioning: one control per unprovisioned tier inside the
// picker's notes list - the size is on the button, progress is a live region
// while running, and failures stay on screen with a retry.
describe("ModelTierDownloadAction (model-tier-provisioning)", () => {
  it("offers a one-click download with the pinned size on the button", () => {
    const onStart = vi.fn();
    render(
      <ModelTierDownloadAction
        tierId="tiny"
        sizeBytes={78_203_619}
        view={null}
        startError={null}
        busy={false}
        onStart={onStart}
      />,
    );

    const button = screen.getByRole("button", { name: "Download tiny (74.6 MB)" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("shows live progress while downloading", () => {
    render(
      <ModelTierDownloadAction
        tierId="large-v3-turbo"
        sizeBytes={1_621_665_643}
        view={{
          state: "downloading",
          bytesReceived: 810_832_822,
          bytesTotal: 1_621_665_643,
          error: null,
        }}
        startError={null}
        busy={true}
        onStart={vi.fn()}
      />,
    );

    const progress = screen.getByRole("progressbar", {
      name: "Downloading large-v3-turbo model",
    });
    expect(progress).toBeInTheDocument();
    expect(progress).toHaveAttribute("max", "1621665643");
    expect(progress).toHaveAttribute("value", "810832822");
    expect(screen.getByText(/Downloading large-v3-turbo:/)).toHaveTextContent(
      "Downloading large-v3-turbo: 773.3 MB of 1.5 GB",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("surfaces a failed download honestly with the error and a retry", () => {
    const onStart = vi.fn();
    render(
      <ModelTierDownloadAction
        tierId="base"
        sizeBytes={147_882_941}
        view={{
          state: "failed",
          bytesReceived: 10,
          bytesTotal: 147_882_941,
          error: "network reset mid-file",
        }}
        startError={null}
        busy={false}
        onStart={onStart}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Download of base failed: network reset mid-file",
    );
    fireEvent.click(screen.getByRole("button", { name: /Retry download base/ }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refused start (for example low disk) as an inline alert", () => {
    render(
      <ModelTierDownloadAction
        tierId="large-v3"
        sizeBytes={3_090_835_362}
        view={null}
        startError="Not enough free disk space to install the 'large-v3' model."
        busy={false}
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not enough free disk space to install the 'large-v3' model.",
    );
  });

  it("disables the button while another tier download is running", () => {
    render(
      <ModelTierDownloadAction
        tierId="tiny"
        sizeBytes={78_203_619}
        view={null}
        startError={null}
        busy={true}
        onStart={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Download tiny (74.6 MB)" })).toBeDisabled();
  });
});
