// @vitest-environment jsdom

import * as React from "react";
import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "./export-dialog";

const fetchMock = vi.fn();
const createObjectUrlMock = vi.fn(() => "blob:export");
const revokeObjectUrlMock = vi.fn();
const anchorClickMock = vi.fn();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const approvedRevisionOption = {
  id: "rev-3",
  version: 3,
  state: "approved",
  stateLabel: "Approved",
  approvedAt: "2026-08-01T12:40:00.000Z",
};
const approvedDecision = {
  revisionId: "rev-3",
  state: "approved",
  actorDisplay: "Approver Example",
  createdAt: "2026-08-01T12:40:00.000Z",
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function createSuccessfulExportResponse(fileName = "approved.txt") {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-disposition": `attachment; filename="${fileName}"`,
    }),
    blob: vi.fn().mockResolvedValue(new Blob(["approved transcript"], { type: "text/plain" })),
  };
}

describe("ExportDialog", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    URL.createObjectURL = createObjectUrlMock;
    URL.revokeObjectURL = revokeObjectUrlMock;

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName === "a") {
        Object.defineProperty(element, "click", {
          configurable: true,
          value: anchorClickMock,
        });
      }
      return element;
    }) as typeof document.createElement);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    document.body.innerHTML = "";
    fetchMock.mockReset();
    createObjectUrlMock.mockReset();
    revokeObjectUrlMock.mockReset();
    anchorClickMock.mockReset();
  });

  function renderDialog(overrides: Partial<ComponentProps<typeof ExportDialog>> = {}) {
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);

    const onClose = vi.fn();
    const onActionModeRejected = vi.fn();
    const onAnnouncement = vi.fn();
    const onSessionRecoveryRequested = vi.fn();

    render(
      <>
        <button type="button">Open export</button>
        <ExportDialog
          actionModeId="mode-1"
          approvalDecisions={[approvedDecision]}
          onActionModeRejected={onActionModeRejected}
          onAnnouncement={onAnnouncement}
          onClose={onClose}
          onSessionRecoveryRequested={onSessionRecoveryRequested}
          open
          recordingId="rec-1"
          revision={{ version: 3, id: "rev-3" }} revisionOptions={[approvedRevisionOption]} hasApprovedRevision
          {...overrides}
        />
      </>,
      { container: appRoot },
    );

    return { onActionModeRejected, onAnnouncement, onClose, onSessionRecoveryRequested };
  }

  function renderManagedDialog(overrides: Partial<ComponentProps<typeof ExportDialog>> = {}) {
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);

    const onClose = vi.fn();
    const onActionModeRejected = vi.fn();
    const onAnnouncement = vi.fn();
    const onSessionRecoveryRequested = vi.fn();

    function Harness() {
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Open export
          </button>
          <ExportDialog
            actionModeId="mode-1"
            approvalDecisions={[approvedDecision]}
            onActionModeRejected={onActionModeRejected}
            onAnnouncement={onAnnouncement}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            onSessionRecoveryRequested={onSessionRecoveryRequested}
            open={open}
            recordingId="rec-1"
            revision={{ version: 3, id: "rev-3" }} revisionOptions={[approvedRevisionOption]} hasApprovedRevision
            {...overrides}
          />
        </>
      );
    }

    render(<Harness />, { container: appRoot });

    return {
      onActionModeRejected,
      onAnnouncement,
      onClose,
      onSessionRecoveryRequested,
      openTrigger: screen.getByRole("button", { name: "Open export" }),
    };
  }

  it("renders the eight grouped formats with approval metadata and legacy fallback", () => {
    const { rerender } = render(
      <ExportDialog
        actionModeId={null}
        approvalDecisions={[approvedDecision]}
        onActionModeRejected={vi.fn()}
        onAnnouncement={vi.fn()}
        onClose={vi.fn()}
        onSessionRecoveryRequested={vi.fn()}
        open
        recordingId="rec-1"
        revision={{ version: 3, id: "rev-3" }} revisionOptions={[approvedRevisionOption]} hasApprovedRevision
      />,
    );

    expect(screen.getByRole("dialog", { name: "Export approved transcript" })).toBeVisible();
    expect(screen.getByText("Approver Example approved revision v3.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Document" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Captions" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Structured data" })).toBeVisible();
    expect(screen.getByRole("button", { name: "DOCX" })).toBeVisible();
    expect(screen.getByRole("button", { name: "TXT" })).toBeVisible();
    expect(screen.getByRole("button", { name: "MD" })).toBeVisible();
    expect(screen.getByRole("button", { name: "SRT" })).toBeVisible();
    expect(screen.getByRole("button", { name: "VTT" })).toBeVisible();
    expect(screen.getByRole("button", { name: "CSV" })).toBeVisible();
    expect(screen.getByRole("button", { name: "TSV" })).toBeVisible();
    expect(screen.getByRole("button", { name: "JSON" })).toBeVisible();

    rerender(
      <ExportDialog
        actionModeId={null}
        approvalDecisions={[]}
        onActionModeRejected={vi.fn()}
        onAnnouncement={vi.fn()}
        onClose={vi.fn()}
        onSessionRecoveryRequested={vi.fn()}
        open
        recordingId="rec-1"
        revision={{ version: 3, id: "rev-3" }} revisionOptions={[{ ...approvedRevisionOption, approvedAt: null }]} hasApprovedRevision
      />,
    );

    expect(screen.getByText("Legacy approval metadata is incomplete for this revision.")).toBeVisible();
  });

  it("updates the heading and approval metadata when the export revision changes", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        actionModeId={null}
        approvalDecisions={[
          {
            revisionId: "rev-2",
            state: "approved",
            actorDisplay: "Approver Example",
          },
        ]}
        onActionModeRejected={vi.fn()}
        onAnnouncement={vi.fn()}
        onClose={vi.fn()}
        onSessionRecoveryRequested={vi.fn()}
        open
        recordingId="rec-1"
        revision={{ version: 1, id: "rev-1" }}
        revisionOptions={[
          { id: "rev-1", version: 1, state: "superseded", stateLabel: "Archived", approvedAt: null },
          { id: "rev-2", version: 2, state: "approved", stateLabel: "Approved", approvedAt: "2026-08-01T12:40:00.000Z" },
        ]}
        hasApprovedRevision
      />,
    );

    expect(screen.getByText("Approved revision v2")).toBeVisible();
    expect(screen.getByText("Approver Example approved revision v2.")).toBeVisible();

    await user.selectOptions(screen.getByRole("combobox", { name: "Revision to export" }), "rev-1");

    expect(screen.getByText("Revision v1 (Archived)")).toBeVisible();
    expect(
      screen.getByText(
        "This revision is not the approved record; its export is still attributed in the audit.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/approved revision v1/)).toBeNull();
  });

  it("locks the viewport, traps focus, supports Escape, and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);

    function Harness() {
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Open export
          </button>
          <ExportDialog
            actionModeId={null}
            approvalDecisions={[approvedDecision]}
            onActionModeRejected={vi.fn()}
            onAnnouncement={vi.fn()}
            onClose={() => setOpen(false)}
            onSessionRecoveryRequested={vi.fn()}
            open={open}
            recordingId="rec-1"
            revision={{ version: 3, id: "rev-3" }} revisionOptions={[approvedRevisionOption]} hasApprovedRevision
          />
        </>
      );
    }

    render(<Harness />, { container: appRoot });

    await user.click(screen.getByRole("button", { name: "Open export" }));

    expect(document.querySelector("#app-root")).toHaveAttribute("inert");
    expect(document.body).toHaveStyle({ overflow: "hidden" });
    expect(screen.getByRole("dialog", { name: "Export approved transcript" })).toHaveClass(
      "export-dialog",
    );
    expect(document.querySelector(".export-backdrop")).toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole("combobox", { name: "Revision to export" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Open export" })).toHaveFocus());
  });

  it("fetches the selected revision blob, includes actionModeId and revisionId, and revokes the object url", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(createSuccessfulExportResponse());

    const { onAnnouncement, onClose } = renderDialog();
    await user.click(screen.getByRole("button", { name: "TXT" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/recordings/rec-1/transcript?format=txt&actionModeId=mode-1&revisionId=rev-3",
      );
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("revisionId=rev-3");
    expect(anchorClickMock).toHaveBeenCalledTimes(1);
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:export");
    expect(onAnnouncement).toHaveBeenCalledWith("Revision v3 exported as TXT.");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open and requests session recovery after a 401", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: false, status: 401, headers: new Headers() });
    const { onClose, onSessionRecoveryRequested } = renderDialog();

    await user.click(screen.getByRole("button", { name: "DOCX" }));

    await waitFor(() => expect(onSessionRecoveryRequested).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "Export approved transcript" })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the modal open on Escape while an export is pending", async () => {
    const user = userEvent.setup();
    const deferredResponse = createDeferred<ReturnType<typeof createSuccessfulExportResponse>>();
    fetchMock.mockReturnValue(deferredResponse.promise);

    const { onClose, openTrigger } = renderManagedDialog();

    await user.click(openTrigger);
    await user.click(screen.getByRole("button", { name: "DOCX" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    await user.keyboard("{Escape}");

    const dialog = screen.getByRole("dialog", { name: "Export approved transcript" });
    expect(dialog).toBeVisible();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    deferredResponse.resolve(createSuccessfulExportResponse());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(openTrigger).toHaveFocus());
  });

  it("keeps the modal open on backdrop click while an export is pending", async () => {
    const user = userEvent.setup();
    const deferredResponse = createDeferred<ReturnType<typeof createSuccessfulExportResponse>>();
    fetchMock.mockReturnValue(deferredResponse.promise);

    const { onClose, openTrigger } = renderManagedDialog();

    await user.click(openTrigger);
    await user.click(screen.getByRole("button", { name: "DOCX" }));

    fireEvent.mouseDown(document.querySelector(".export-backdrop") as Element);

    const dialog = screen.getByRole("dialog", { name: "Export approved transcript" });
    expect(dialog).toBeVisible();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    deferredResponse.resolve(createSuccessfulExportResponse());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(openTrigger).toHaveFocus());
  });

  it("keeps the modal open on Close while an export is pending", async () => {
    const user = userEvent.setup();
    const deferredResponse = createDeferred<ReturnType<typeof createSuccessfulExportResponse>>();
    fetchMock.mockReturnValue(deferredResponse.promise);

    const { onClose, openTrigger } = renderManagedDialog();

    await user.click(openTrigger);
    await user.click(screen.getByRole("button", { name: "DOCX" }));

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton).toBeDisabled();
    await user.click(closeButton);

    const dialog = screen.getByRole("dialog", { name: "Export approved transcript" });
    expect(dialog).toBeVisible();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    deferredResponse.resolve(createSuccessfulExportResponse());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(openTrigger).toHaveFocus());
  });

  it("renders inline 403 and 409 errors", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(""),
      })
      .mockResolvedValueOnce({ ok: false, status: 409, headers: new Headers() });
    renderDialog();

    await user.click(screen.getByRole("button", { name: "DOCX" }));
    expect(
      await screen.findByText(
        /Administrators: open Governance on this casefile and choose Enter approver action mode/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        /open Governance on this casefile and choose Enter approver action mode, then retry the download - attribution stays intact\./,
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "TXT" }));
    expect(
      await screen.findByText("This casefile no longer has an active approved revision."),
    ).toBeVisible();
  });

  it("keeps focus on the selected format after a network failure and retries successfully", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: vi.fn().mockResolvedValue(new Blob(["approved transcript"], { type: "text/plain" })),
      });

    const { onClose } = renderDialog();

    await user.click(screen.getByRole("button", { name: "JSON" }));
    expect(await screen.findByText("Export could not be prepared. Try again.")).toBeVisible();
    expect(screen.getByRole("button", { name: "JSON" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "JSON" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
