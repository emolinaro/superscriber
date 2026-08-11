// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatBytes, TransferProgress, nextProgressAnnouncement } from "./transfer-progress";

afterEach(() => {
  cleanup();
});

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

describe("formatBytes", () => {
  it("scales from bytes through gigabytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(78_203_619)).toBe("74.6 MB");
    expect(formatBytes(1_621_665_643)).toBe("1.5 GB");
    expect(formatBytes(3_090_835_362)).toBe("2.9 GB");
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

  it("supports an honest idle detail line in place of committed bytes", () => {
    render(
      <TransferProgress
        announcement=""
        bytesExpected={0}
        bytesReceived={0}
        detail="No transfer in progress."
        statusLabel="Idle"
      />,
    );

    expect(screen.getByText("Idle")).toBeVisible();
    expect(screen.getByText("No transfer in progress.")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
  });
});
