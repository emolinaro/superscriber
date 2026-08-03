// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RootError from "../../../app/error";
import AuthenticatedError from "../../../app/(authenticated)/error";
import AdministrationLoading from "../../../app/(authenticated)/administration/loading";
import IngestLoading from "../../../app/(authenticated)/ingest/loading";
import RecordingLoading from "../../../app/(authenticated)/recordings/[recordingId]/loading";
import RecordingNotFound from "../../../app/(authenticated)/recordings/[recordingId]/not-found";
import WorkspaceLoading from "../../../app/(authenticated)/workspace/loading";
import RootLoading from "../../../app/loading";
import { PageSkeleton } from "./page-skeleton";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("PageSkeleton", () => {
  it.each([
    "authentication",
    "work inbox",
    "ingest",
    "casefile",
    "administration",
  ])("announces the %s loading boundary", (surface) => {
    render(<PageSkeleton surface={surface} />);
    expect(screen.getByRole("status")).toHaveTextContent(`Loading ${surface}`);
  });
});

describe("route loading boundaries", () => {
  it.each([
    ["authentication", RootLoading, "page-skeleton--auth"],
    ["work inbox", WorkspaceLoading, "page-skeleton--work"],
    ["ingest", IngestLoading, "page-skeleton--ingest"],
    ["casefile", RecordingLoading, "page-skeleton--casefile"],
    ["administration", AdministrationLoading, "page-skeleton--administration"],
  ])("announces Loading %s and applies %s geometry", (_surface, LoadingComponent, geometryClass) => {
    render(<LoadingComponent />);

    expect(screen.getByRole("status", { name: `Loading ${_surface}` })).toHaveClass(
      "page-skeleton",
      geometryClass,
    );
  });
});

describe("route error boundaries", () => {
  it("keeps the root authentication boundary safe and retry-only", () => {
    const reset = vi.fn();

    render(
      <RootError
        error={Object.assign(new Error("SQLITE_ERROR: secret at /private/path"), {
          digest: "digest-1",
        })}
        reset={reset}
      />,
    );

    expect(screen.getByRole("heading", { name: "Superscriber could not load sign-in." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByText(/SQLITE_ERROR|secret|\/private\/path|digest-1/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back to Work" })).not.toBeInTheDocument();
  });

  it("keeps the authenticated boundary safe and only shows a provided correlation id", () => {
    const reset = vi.fn();

    render(
      <AuthenticatedError
        error={Object.assign(new Error("adapter secret /srv/app"), {
          correlationId: "corr-123",
          digest: "digest-2",
        })}
        reset={reset}
      />,
    );

    expect(screen.getByRole("heading", { name: "Superscriber could not load this page." })).toBeVisible();
    expect(screen.getByText("Reference: corr-123")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to Work" })).toHaveAttribute(
      "href",
      "/workspace",
    );
    expect(screen.queryByText(/adapter|secret|\/srv\/app|digest-2/)).not.toBeInTheDocument();
  });

  it("does not invent a correlation id when one was not provided", () => {
    const reset = vi.fn();

    render(
      <AuthenticatedError error={Object.assign(new Error("stack trace"), { digest: "digest-3" })} reset={reset} />,
    );

    expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
  });

  it("renders the casefile not-found boundary with one Back to Work action", () => {
    render(<RecordingNotFound />);

    const page = screen.getByText("Casefile not found").closest("div") ?? document.body;
    const actions = within(page).getAllByRole("link");

    expect(actions).toHaveLength(1);
    expect(actions[0]).toHaveAccessibleName("Back to Work");
    expect(actions[0]).toHaveAttribute("href", "/workspace");
  });
});
