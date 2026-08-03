// @vitest-environment jsdom

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTimeUtc } from "@/lib/format";
import { DecisionDialog } from "./decision-dialog";

function renderDialog(kind: "submit" | "withdraw" | "requestChanges" | "approve" | "reopen", onConfirm = vi.fn()) {
  const appRoot = document.createElement("div");
  appRoot.id = "app-root";
  document.body.append(appRoot);

  render(
    <DecisionDialog
      kind={kind}
      onCancel={vi.fn()}
      onConfirm={onConfirm}
      open
      revision={{
        version: 3,
        submittedAt: "2026-08-01T12:10:00.000Z",
        submittedByDisplay: "Reviewer Example",
        approvedAt: "2026-08-01T12:40:00.000Z",
        segments: [{ id: "seg-1" }, { id: "seg-2" }],
      }}
    />,
    { container: appRoot },
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DecisionDialog", () => {
  it("renders submit facts and the final submit label", () => {
    renderDialog("submit");

    expect(screen.getByRole("dialog", { name: "Submit for approval" })).toBeVisible();
    expect(screen.getByText("Revision v3")).toBeVisible();
    expect(screen.getByText("Submitted by Reviewer Example")).toBeVisible();
    expect(
      screen.getByText(`Submitted at ${formatDateTimeUtc("2026-08-01T12:10:00.000Z")}`),
    ).toBeVisible();
    expect(screen.getByText("Segments 2")).toBeVisible();
    expect(
      screen.getByText(
        "Submit the current draft for approval. You will stop editing until the revision returns to draft review.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeEnabled();
  });

  it.each([
    ["submit", "Submit for approval"],
    ["withdraw", "Withdraw revision"],
    ["requestChanges", "Request changes"],
    ["approve", "Approve and complete work"],
    ["reopen", "Reopen as draft"],
  ] as const)("uses the exact final label for %s", (kind, label) => {
    renderDialog(kind);
    expect(screen.getByRole("button", { name: label })).toBeVisible();
  });

  it("requires a 10 to 500 character reason for withdrawal and shows the warning copy", async () => {
    const user = userEvent.setup();
    renderDialog("withdraw");

    expect(
      screen.getByText("Withdrawing returns the pending revision to an editable draft for the original submitter."),
    ).toBeVisible();
    expect(screen.getByLabelText("Reason")).toHaveAttribute("minlength", "10");
    expect(screen.getByText("0/500")).toBeVisible();
    expect(screen.getByRole("button", { name: "Withdraw revision" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Too short" } });
    expect(screen.getByText("9/500")).toBeVisible();
    expect(screen.getByRole("button", { name: "Withdraw revision" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Too short reason" } });
    expect(screen.getByText("16/500")).toBeVisible();
    expect(screen.getByRole("button", { name: "Withdraw revision" })).toBeEnabled();
  });

  it("supports an optional approval note up to 500 characters", () => {
    renderDialog("approve");

    const note = screen.getByLabelText("Approval note, optional");
    expect(screen.getByRole("button", { name: "Approve and complete work" })).toBeEnabled();

    fireEvent.change(note, { target: { value: "a".repeat(500) } });
    expect(screen.getByText("500/500")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve and complete work" })).toBeEnabled();

    fireEvent.change(note, { target: { value: "a".repeat(501) } });
    expect(screen.getByRole("button", { name: "Approve and complete work" })).toBeDisabled();
  });

  it("renders request changes and reopen consequence copy", () => {
    const { rerender } = render(
      <DecisionDialog
        kind="requestChanges"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open
        revision={{
          version: 3,
          submittedAt: "2026-08-01T12:10:00.000Z",
          submittedByDisplay: "Reviewer Example",
          approvedAt: "2026-08-01T12:40:00.000Z",
          segments: [{ id: "seg-1" }, { id: "seg-2" }],
        }}
      />,
    );

    expect(
      screen.getByText("Requesting changes returns the revision to draft review and keeps the current approval blocked."),
    ).toBeVisible();

    rerender(
      <DecisionDialog
        kind="reopen"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open
        revision={{
          version: 3,
          submittedAt: "2026-08-01T12:10:00.000Z",
          submittedByDisplay: "Reviewer Example",
          approvedAt: "2026-08-01T12:40:00.000Z",
          segments: [{ id: "seg-1" }, { id: "seg-2" }],
        }}
      />,
    );

    expect(
      screen.getByText("Reopening creates a new editable draft cycle from the active approved revision."),
    ).toBeVisible();
  });

  it("preserves the entered reason after an in-place network error", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue({
      ok: false,
      error: "Something went wrong. Try again.",
    });
    renderDialog("requestChanges", onConfirm);

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Please add the missing governed context." },
    });
    await user.click(screen.getByRole("button", { name: "Request changes" }));

    expect(onConfirm).toHaveBeenCalledWith({
      note: "",
      reason: "Please add the missing governed context.",
    });
    expect(await screen.findByText("Something went wrong. Try again.")).toBeVisible();
    expect(screen.getByLabelText("Reason")).toHaveValue(
      "Please add the missing governed context.",
    );
  });

  it("does not surface the attempted losing reason after a conflict closes the dialog", async () => {
    const user = userEvent.setup();

    function ConflictHarness() {
      const [open, setOpen] = React.useState(true);
      const [audit, setAudit] = React.useState<string[]>([]);

      return (
        <>
          <DecisionDialog
            kind="withdraw"
            onCancel={() => setOpen(false)}
            onConfirm={async () => {
              setOpen(false);
              return { ok: false } as const;
            }}
            open={open}
            revision={{
              version: 3,
              submittedAt: "2026-08-01T12:10:00.000Z",
              submittedByDisplay: "Reviewer Example",
              approvedAt: "2026-08-01T12:40:00.000Z",
              segments: [{ id: "seg-1" }, { id: "seg-2" }],
            }}
          />
          <ul>
            {audit.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      );
    }

    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);
    render(<ConflictHarness />, { container: appRoot });

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "This losing reason must not be recorded." },
    });
    await user.click(screen.getByRole("button", { name: "Withdraw revision" }));

    expect(screen.queryByRole("dialog", { name: "Withdraw revision" })).not.toBeInTheDocument();
    expect(screen.queryByText("This losing reason must not be recorded.")).not.toBeInTheDocument();
  });
});
