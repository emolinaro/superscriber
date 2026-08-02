// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TransferProgress, nextProgressAnnouncement } from "./transfer-progress";

describe("nextProgressAnnouncement", () => {
  it("announces only start, ten-percent boundaries, and completion", () => {
    let boundary = -1;
    const announcements: string[] = [];

    for (const percent of [1, 5, 10, 11, 20, 100]) {
      const next = nextProgressAnnouncement(boundary, percent);
      if (next) {
        boundary = next.boundary;
        announcements.push(next.message);
      }
    }

    expect(announcements).toEqual([
      "Upload started.",
      "10 percent uploaded.",
      "20 percent uploaded.",
      "Upload complete.",
    ]);
  });
});

describe("TransferProgress", () => {
  it("renders a native progress indicator with committed byte detail and live text", () => {
    render(
      <TransferProgress
        announcement="Finalizing upload."
        bytesExpected={1024}
        bytesReceived={512}
        statusLabel="Uploading"
      />,
    );

    expect(screen.getByText("Uploading")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "512");
    expect(screen.getByRole("progressbar")).toHaveAttribute("max", "1024");
    expect(screen.getByText("512 B of 1.0 KB committed")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Finalizing upload.");
  });
});
