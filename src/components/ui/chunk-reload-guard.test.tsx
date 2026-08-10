// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkReloadGuard } from "./chunk-reload-guard";

const MARKER = "superscriber.chunk-reload-at";

let reloadMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.sessionStorage.clear();
  reloadMock = vi.fn();
});

afterEach(cleanup);

function renderGuard() {
  return render(<ChunkReloadGuard reload={reloadMock} />);
}

describe("ChunkReloadGuard", () => {
  it("reloads once when a stale chunk error surfaces", () => {
    renderGuard();

    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "ChunkLoadError: Loading chunk 123 failed.",
      }),
    );

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("reloads for rejections from dynamically imported modules", () => {
    renderGuard();

    const event = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(event, "reason", {
      value: new TypeError("Failed to fetch dynamically imported module: /_next/static/chunks/x.js"),
    });
    window.dispatchEvent(event);

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("throttles reloads so a crash loop cannot spin", () => {
    renderGuard();

    window.dispatchEvent(new ErrorEvent("error", { message: "ChunkLoadError: boom" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "ChunkLoadError: boom again" }));

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated errors", () => {
    renderGuard();

    window.dispatchEvent(new ErrorEvent("error", { message: "Something else failed" }));

    expect(reloadMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(MARKER)).toBeNull();
  });

  it("removes its listeners on unmount", () => {
    const { unmount } = renderGuard();
    unmount();

    window.dispatchEvent(new ErrorEvent("error", { message: "ChunkLoadError: late" }));

    expect(reloadMock).not.toHaveBeenCalled();
  });
});
